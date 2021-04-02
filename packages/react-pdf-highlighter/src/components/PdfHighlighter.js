// @flow
import React, { PureComponent } from "react";
import ReactDom from "react-dom";
import Pointable from "react-pointable";
import debounce from "lodash.debounce";

import { EventBus, PDFViewer, PDFLinkService } from "pdfjs-dist/web/pdf_viewer";

//$FlowFixMe
import "pdfjs-dist/web/pdf_viewer.css";
import "../style/pdf_viewer.css";

import "../style/PdfHighlighter.css";

import getBoundingRect from "../lib/get-bounding-rect";
import getClientRects from "../lib/get-client-rects";
import getAreaAsPng from "../lib/get-area-as-png";

import {
  asElement,
  getPageFromRange,
  getPageFromElement,
  getWindow,
  findOrCreateContainerLayer,
  isHTMLElement
} from "../lib/pdfjs-dom";

import TipContainer from "./TipContainer";
import MouseSelection from "./MouseSelection";

import { scaledToViewport, viewportToScaled } from "../lib/coordinates";

import type {
  T_Position,
  T_ScaledPosition,
  T_Highlight,
  T_Scaled,
  T_LTWH,
  T_EventBus,
  T_PDFJS_Viewer,
  T_PDFJS_Document,
  T_PDFJS_LinkService
} from "../types";

type T_ViewportHighlight<T_HT> = { position: T_Position } & T_HT;

type State<T_HT> = {
  ghostHighlight: ?{
    position: T_ScaledPosition
  },
  isCollapsed: boolean,
  range: ?Range,
  tip: ?{
    highlight: T_ViewportHighlight<T_HT>,
    callback: (highlight: T_ViewportHighlight<T_HT>) => React$Element<*>
  },
  tipPosition: T_Position | null,
  tipChildren: ?React$Element<*> | null,
  isAreaSelectionInProgress: boolean,
  scrolledToHighlightId: string
};

type Props<T_HT> = {
  selectionTransform: (
    definition: T_ViewportHighlight<T_HT>,
    index: number
  ) => React$Element<*>,
  definitionTransform: (
    definition: T_ViewportHighlight<T_HT>,
    index: number
  ) => React$Element<*>,
  noteTransform: (
    definition: T_ViewportHighlight<T_HT>,
    index: number
  ) => React$Element<*>,
  labelTransform: (
    highlight: T_ViewportHighlight<T_HT>,
    index: number
  ) => React$Element<*>,
  highlightTransform: (
    highlight: T_ViewportHighlight<T_HT>,
    index: number,
    setTip: (
      highlight: T_ViewportHighlight<T_HT>,
      callback: (highlight: T_ViewportHighlight<T_HT>) => React$Element<*>
    ) => void,
    hideTip: () => void,
    viewportToScaled: (rect: T_LTWH) => T_Scaled,
    screenshot: (position: T_LTWH) => string,
    isScrolledTo: boolean
  ) => React$Element<*>,
  highlights: Array<T_HT>,
  definitions: Array<T_HT>,
  notes: Array<T_HT>,
  onScrollChange: () => void,
  scrollRef: (scrollTo: (highlight: T_Highlight) => void) => void,
  pdfDocument: T_PDFJS_Document,
  pdfScaleValue: string,
  onSelectionFinished: (
    position: T_ScaledPosition,
    content: { text?: string, image?: string },
    hideTipAndSelection: () => void,
    transformSelection: () => void
  ) => ?React$Element<*>,
  enableAreaSelection: (event: MouseEvent) => boolean,
  onInit: (pdfHighlighter: PdfHighlighter) => void
};

const EMPTY_ID = "empty-id";

class PdfHighlighter<T_HT: T_Highlight> extends PureComponent<
  Props<T_HT>,
  State<T_HT>
> {
  static defaultProps = {
    pdfScaleValue: "auto",
    labelTransform: () => null,
    definitionTransform: () => null,
    noteTransform: () => null,
    onInit: () => null,
    definitions: [],
    notes: [],
  };

  state: State<T_HT> = {
    ghostHighlight: null,
    selection: null,
    isCollapsed: true,
    range: null,
    scrolledToHighlightId: EMPTY_ID,
    isAreaSelectionInProgress: false,
    tip: null,
    tipPosition: null,
    tipChildren: null
  };

  eventBus: T_EventBus = new EventBus();
  linkService: T_PDFJS_LinkService = new PDFLinkService({
    eventBus: this.eventBus,
    externalLinkTarget: 2
  });
  viewer: T_PDFJS_Viewer;

  resizeObserver = null;
  containerNode: ?HTMLDivElement = null;
  unsubscribe = () => {};

  constructor(props: Props<T_HT>) {
    super(props);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.debouncedScaleValue);
    }
  }

  componentDidMount() {
    this.init();
  }

  attachRef = (ref: ?HTMLDivElement) => {
    const { eventBus, resizeObserver: observer } = this;
    this.containerNode = ref;
    this.unsubscribe();

    if (ref) {
      const { ownerDocument: doc } = ref;
      eventBus.on("textlayerrendered", this.onTextLayerRendered);
      eventBus.on("pagesinit", this.onDocumentReady);
      doc.addEventListener("click", this.onSelectionChange);
      doc.addEventListener("keydown", this.handleKeyDown);
      doc.defaultView.addEventListener("resize", this.debouncedScaleValue);
      if (observer) observer.observe(ref);

      this.unsubscribe = () => {
        eventBus.off("pagesinit", this.onDocumentReady);
        eventBus.off("textlayerrendered", this.onTextLayerRendered);
        doc.removeEventListener("click", this.onSelectionChange);
        doc.removeEventListener("keydown", this.handleKeyDown);
        doc.defaultView.removeEventListener("resize", this.debouncedScaleValue);
        if (observer) observer.disconnect();
      };
    }
  };

  componentDidUpdate(prevProps: Props<T_HT>) {
    if (prevProps.pdfDocument !== this.props.pdfDocument) {
      this.init();
      return;
    }
    if (prevProps.highlights !== this.props.highlights) {
      this.renderHighlights(this.props);
    }
    if (prevProps.definitions !== this.props.definitions) {
      this.renderDefinitions(this.props);
    }
    if (prevProps.notes !== this.props.notes) {
      this.renderNotes(this.props);
    }
  }

  init() {
    const { pdfDocument } = this.props;

    this.viewer =
      this.viewer ||
      new PDFViewer({
        container: this.containerNode,
        eventBus: this.eventBus,
        enhanceTextSelection: true,
        removePageBorders: true,
        linkService: this.linkService,
        textLayerMode: 2
      });

    this.linkService.setDocument(pdfDocument);
    this.linkService.setViewer(this.viewer);
    this.viewer.setDocument(pdfDocument);
    this.props.onInit(this);

    // debug
    window.PdfViewer = this;
  }

  componentWillUnmount() {
    this.unsubscribe();
  }

  findOrCreateHighlightLayer(page: number) {
    const { textLayer } = this.viewer.getPageView(page - 1) || {};

    if (!textLayer) {
      return null;
    }

    return findOrCreateContainerLayer(
      textLayer.textLayerDiv,
      "PdfHighlighter__highlight-layer"
    );
  }

  findOrCreateLabelLayer(page: number) {
    const { textLayer } = this.viewer.getPageView(page - 1) || {};

    if (!textLayer) {
      return null;
    }

    return findOrCreateContainerLayer(
      textLayer.textLayerDiv.parentNode,
      "PdfHighlighter__labels-layer"
    );
  }

  findOrCreateDefinitionLayer(page: number) {
    const { textLayer } = this.viewer.getPageView(page - 1) || {};

    if (!textLayer) {
      return null;
    }

    return findOrCreateContainerLayer(
      textLayer.textLayerDiv.parentNode,
      "PdfHighlighter__definitions-layer"
    );
  }

  findOrCreateNotesLayer(page: number) {
    const { textLayer } = this.viewer.getPageView(page - 1) || {};

    if (!textLayer) {
      return null;
    }

    return findOrCreateContainerLayer(
      textLayer.textLayerDiv.parentNode,
      "PdfHighlighter__notes-layer"
    );
  }

  findOrCreateSelectionLayer(page: number) {
    const { textLayer } = this.viewer.getPageView(page - 1) || {};

    if (!textLayer) {
      return null;
    }

    return findOrCreateContainerLayer(
      textLayer.textLayerDiv.parentNode,
      "PdfHighlighter__selections-layer"
    );
  }

  groupHighlightsByPage(
    highlights: Array<T_HT>
  ): { [pageNumber: string]: Array<T_HT> } {
    const { ghostHighlight } = this.state;

    return [...highlights, ghostHighlight]
      .filter(Boolean)
      .reduce((res, highlight) => {
        const { pageNumber } = highlight.position;

        res[pageNumber] = res[pageNumber] || [];
        res[pageNumber].push(highlight);

        return res;
      }, {});
  }

  showTip(highlight: T_ViewportHighlight<T_HT>, content: React$Element<*>) {
    const {
      isCollapsed,
      ghostHighlight,
      isAreaSelectionInProgress
    } = this.state;

    const highlightInProgress = !isCollapsed || ghostHighlight;

    if (highlightInProgress || isAreaSelectionInProgress) {
      return;
    }

    this.setTip(highlight.position, content);
  }

  scaledPositionToViewport = ({
    pageNumber,
    boundingRect,
    rects,
    usePdfCoordinates
  }: T_ScaledPosition): T_Position => {
    const viewport = this.viewer.getPageView(pageNumber - 1).viewport;

    return {
      boundingRect: scaledToViewport(boundingRect, viewport, usePdfCoordinates),
      rects: (rects || []).map(rect =>
        scaledToViewport(rect, viewport, usePdfCoordinates)
      ),
      pageNumber
    };
  };

  viewportPositionToScaled({
    pageNumber,
    boundingRect,
    rects
  }: T_Position): T_ScaledPosition {
    const viewport = this.viewer.getPageView(pageNumber - 1).viewport;

    return {
      boundingRect: viewportToScaled(boundingRect, viewport),
      rects: (rects || []).map(rect => viewportToScaled(rect, viewport)),
      pageNumber
    };
  }

  screenshot(position: T_LTWH, pageNumber: number) {
    const canvas = this.viewer.getPageView(pageNumber - 1).canvas;

    return getAreaAsPng(canvas, position);
  }

  renderHighlights(nextProps?: Props<T_HT>) {
    const { highlightTransform, labelTransform, highlights } = nextProps || this.props;
    const { pdfDocument } = this.props;
    const { tip, scrolledToHighlightId } = this.state;
    const highlightsByPage = this.groupHighlightsByPage(highlights);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const highlightLayer = this.findOrCreateHighlightLayer(pageNumber);
      const labelLayer = this.findOrCreateLabelLayer(pageNumber);

      if (highlightLayer) {
        ReactDom.render(
          <div>
            {(highlightsByPage[String(pageNumber)] || []).map(
              ({ position, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  position: this.scaledPositionToViewport(position),
                  ...highlight
                };

                if (tip && tip.highlight.id === String(id)) {
                  this.showTip(tip.highlight, tip.callback(viewportHighlight));
                }

                const isScrolledTo = Boolean(scrolledToHighlightId === id);

                return highlightTransform(
                  viewportHighlight,
                  index,
                  (highlight, callback) => {
                    this.setState({
                      tip: { highlight, callback }
                    });

                    this.showTip(highlight, callback(highlight));
                  },
                  this.hideTipAndSelection,
                  rect => {
                    const viewport = this.viewer.getPageView(pageNumber - 1)
                      .viewport;

                    return viewportToScaled(rect, viewport);
                  },
                  boundingRect => this.screenshot(boundingRect, pageNumber),
                  isScrolledTo
                );
              }
            )}
          </div>,
          highlightLayer
        );
      }

      if (labelLayer) {
        ReactDom.render(
          <div>
            {(highlightsByPage[String(pageNumber)] || []).map(
              ({ position, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  position: this.scaledPositionToViewport(position),
                  ...highlight
                };

                return labelTransform(viewportHighlight, index);
              }
            )}
          </div>,
          labelLayer
        );
      }
    }
  }

  renderDefinitions(nextProps?: Props<T_HT>) {
    const { definitionTransform, definitions } = nextProps || this.props;
    const { pdfDocument } = this.props;
    const definitionsByPage = this.groupHighlightsByPage(definitions);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const definitionLayer = this.findOrCreateDefinitionLayer(pageNumber);

      if (definitionLayer) {
        ReactDom.render(
          <div>
            {(definitionsByPage[String(pageNumber)] || []).map(
              ({ position, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  position: this.scaledPositionToViewport(position),
                  ...highlight
                };

                return definitionTransform(viewportHighlight, index);
              }
            )}
          </div>,
          definitionLayer
        );
      }
    }
  }

  renderNotes(nextProps?: Props<T_HT>) {
    const { noteTransform, notes } = nextProps || this.props;
    const { pdfDocument } = this.props;
    const notesByPage = this.groupHighlightsByPage(notes);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const notesLayer = this.findOrCreateNotesLayer(pageNumber);

      if (notesLayer) {
        ReactDom.render(
          <div>
            {(notesByPage[String(pageNumber)] || []).map(
              ({ position, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  position: this.scaledPositionToViewport(position),
                  ...highlight
                };

                return noteTransform(viewportHighlight, index);
              }
            )}
          </div>,
          notesLayer
        );
      }
    }
  }

  renderSelections(nextProps?: Props<T_HT>) {
    const { selection } = this.state;
    const { selectionTransform } = nextProps || this.props;
    const { pdfDocument } = this.props;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const selectionLayer = this.findOrCreateSelectionLayer(pageNumber);

      if (selectionLayer) {
        const sTransform = selection && selection.position.pageNumber === pageNumber ?
          selectionTransform({ ...selection,
            position: this.scaledPositionToViewport(selection.position)
          }) : [];

        ReactDom.render(
          <div>
            {sTransform}
          </div>,
          selectionLayer
        );
      }
    }
  }

  clearSelection = () => {
    this.setState({ selection: null }, this.renderSelections);
  };

  hideTipAndSelection = () => {
    this.setState({
      tipPosition: null,
      tipChildren: null
    });

    this.setState({ ghostHighlight: null, tip: null }, () =>
      this.renderHighlights()
    );
  };

  setTip(position: T_Position, inner: ?React$Element<*>) {
    this.setState({
      tipPosition: position,
      tipChildren: inner
    });
  }

  renderTip = () => {
    const { tipPosition, tipChildren } = this.state;
    if (!tipPosition) return null;

    const { boundingRect, pageNumber } = tipPosition;
    const page = {
      node: this.viewer.getPageView(pageNumber - 1).div
    };

    return (
      <TipContainer
        scrollTop={this.viewer.container.scrollTop}
        pageBoundingRect={page.node.getBoundingClientRect()}
        style={{
          left:
            page.node.offsetLeft + boundingRect.left + boundingRect.width / 2,
          top: boundingRect.top + page.node.offsetTop,
          bottom: boundingRect.top + page.node.offsetTop + boundingRect.height
        }}
      >
        {tipChildren}
      </TipContainer>
    );
  };

  onTextLayerRendered = () => {
    this.renderNotes();
    this.renderDefinitions();
    this.renderHighlights();
  };

  scrollTo = (highlight: T_Highlight) => {
    const { pageNumber, boundingRect, usePdfCoordinates } = highlight.position;

    this.viewer.container.removeEventListener("scroll", this.onScroll);

    const pageViewport = this.viewer.getPageView(pageNumber - 1).viewport;

    const scrollMargin = 10;

    this.viewer.scrollPageIntoView({
      pageNumber,
      destArray: [
        null,
        { name: "XYZ" },
        ...pageViewport.convertToPdfPoint(
          0,
          scaledToViewport(boundingRect, pageViewport, usePdfCoordinates).top -
            scrollMargin
        ),
        0
      ]
    });

    this.setState(
      {
        scrolledToHighlightId: highlight.id
      },
      () => this.renderHighlights()
    );

    // wait for scrolling to finish
    setTimeout(() => {
      this.viewer.container.addEventListener("scroll", this.onScroll);
    }, 100);
  };

  onDocumentReady = () => {
    const { scrollRef } = this.props;

    this.handleScaleValue();

    scrollRef(this.scrollTo);
  };

  onSelectionChange = () => {
    const container = this.containerNode;
    const selection: Selection = getWindow(container).getSelection();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (selection && (
      selection.baseNode.parentNode.className.includes("definition") ||
      selection.baseNode.parentNode.className.includes("popover")
    )) {
      return null;
    }

    if (selection.isCollapsed) {
      this.setState({ isCollapsed: true });
      return;
    }

    if (
      !range ||
      !container ||
      !container.contains(range.commonAncestorContainer)
    ) {
      return;
    }

    this.setState({
      isCollapsed: false,
      range
    });

    this.afterSelection();
    // this.debouncedAfterSelection();
  };

  onScroll = () => {
    const { onScrollChange } = this.props;

    onScrollChange();

    this.setState(
      {
        scrolledToHighlightId: EMPTY_ID
      },
      () => this.renderHighlights()
    );

    this.viewer.container.removeEventListener("scroll", this.onScroll);
  };

  onMouseDown = (event: MouseEvent) => {
    if (!isHTMLElement(event.target)) {
      return;
    }

    if (asElement(event.target).closest(".PdfHighlighter__tip-container")) {
      return;
    }

    this.hideTipAndSelection();
  };

  handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") {
      this.hideTipAndSelection();
    }
  };

  afterSelection = () => {
    const { onSelectionFinished } = this.props;

    const { isCollapsed, range } = this.state;

    if (!range || isCollapsed) {
      return;
    }

    const page = getPageFromRange(range);

    if (!page) {
      return;
    }

    const rects = getClientRects(range, page.node);

    if (rects.length === 0) {
      return;
    }

    const boundingRect = getBoundingRect(rects);

    const viewportPosition = { boundingRect, rects, pageNumber: page.number };

    const content = {
      text: range.toString()
    };
    const scaledPosition = this.viewportPositionToScaled(viewportPosition);
    this.setState({ selection: { position: scaledPosition } }, this.renderSelections);
    window.getSelection().removeAllRanges();
    onSelectionFinished(
      scaledPosition,
      content
    );
  };

  debouncedAfterSelection: () => void = debounce(this.afterSelection, 500);

  toggleTextSelection(flag: boolean) {
    this.viewer.viewer.classList.toggle(
      "PdfHighlighter--disable-selection",
      flag
    );
  }

  handleScaleValue = () => {
    if (this.viewer) {
      this.viewer.currentScaleValue = this.props.pdfScaleValue; //"page-width";
    }
  };

  debouncedScaleValue: () => void = debounce(this.handleScaleValue, 500);

  render() {
    const { onSelectionFinished, enableAreaSelection } = this.props;

    return (
      <Pointable onPointerDown={this.onMouseDown}>
        <div
          ref={this.attachRef}
          className="PdfHighlighter"
          onContextMenu={e => e.preventDefault()}
        >
          <div className="pdfViewer" />
          {this.renderTip()}
          {typeof enableAreaSelection === "function" ? (
            <MouseSelection
              onDragStart={() => this.toggleTextSelection(true)}
              onDragEnd={() => this.toggleTextSelection(false)}
              onChange={isVisible =>
                this.setState({ isAreaSelectionInProgress: isVisible })
              }
              shouldStart={event =>
                enableAreaSelection(event) &&
                isHTMLElement(event.target) &&
                Boolean(asElement(event.target).closest(".page"))
              }
              onSelection={(startTarget, boundingRect, resetSelection) => {
                const page = getPageFromElement(startTarget);

                if (!page) {
                  return;
                }

                const pageBoundingRect = {
                  ...boundingRect,
                  top: boundingRect.top - page.node.offsetTop,
                  left: boundingRect.left - page.node.offsetLeft
                };

                const viewportPosition = {
                  boundingRect: pageBoundingRect,
                  rects: [],
                  pageNumber: page.number
                };

                const scaledPosition = this.viewportPositionToScaled(
                  viewportPosition
                );

                const image = this.screenshot(pageBoundingRect, page.number);

                this.setTip(
                  viewportPosition,
                  onSelectionFinished(
                    scaledPosition,
                    { image },
                    () => this.hideTipAndSelection(),
                    () =>
                      this.setState(
                        {
                          ghostHighlight: {
                            position: scaledPosition,
                            content: { image }
                          }
                        },
                        () => {
                          resetSelection();
                          this.renderHighlights();
                        }
                      )
                  )
                );
              }}
            />
          ) : null}
        </div>
      </Pointable>
    );
  }
}

export default PdfHighlighter;
