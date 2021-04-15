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
import getClientRectsNew from '../lib/get-client-rects-new';

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
    isScrolledTo: boolean
  ) => React$Element<*>,
  highlights: Array<T_HT>,
  definitions: Array<T_HT>,
  notes: Array<T_HT>,
  onScrollChange: () => void,
  scrollRef: (scrollTo: (highlight: T_Highlight) => void) => void,
  pdfDocument: T_PDFJS_Document,
  pdfScaleValue: string,
  withoutSelection: boolean,
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
    withoutSelection: false,
    labelTransform: () => null,
    definitionTransform: () => null,
    noteTransform: () => null,
    selectionTransform: () => null,
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
    console.log("PdfHighlighter, ", "componentDidMount --- ");
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
    if (prevProps.pdfScaleValue !== this.props.pdfScaleValue) {
      this.handleScaleValue();
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

  groupHighlightsByPage(highlights: Array<T_HT>): { [pageNumber: string]: Array<T_HT> } {

    return highlights
      .filter(Boolean)
      .reduce((res, highlight) => {
        highlight.pages.forEach(page => {
          res[page] = res[page] || [];
          res[page].push(highlight);
        });

        return res;
      }, {});
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

  viewportRectsToScaled(rects: T_Position) {
    const viewport = this.viewer.getPageView(pageNumber).viewport;

   return (rects || []).map(rect => scaledToViewport(rect, viewport));
  }

  viewportSelectionRectsToScaled(rects : T_Position) {
    return [
      viewportToScaled(rects[0], this.viewer.getPageView(rects[0].page - 1).viewport),
      viewportToScaled(rects[1], this.viewer.getPageView(rects[1].page - 1).viewport)
    ];
  }

  // screenshot(position: T_LTWH, pageNumber: number) {
  //   const canvas = this.viewer.getPageView(pageNumber - 1).canvas;
  //
  //   return getAreaAsPng(canvas, position);
  // }

  renderHighlights(nextProps?: Props<T_HT>) {
    const { highlightTransform, labelTransform, highlights } = nextProps || this.props;
    const { pdfDocument } = this.props;
    const { scrolledToHighlightId } = this.state;
    const highlightsByPage = this.groupHighlightsByPage(highlights);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const highlightLayer = this.findOrCreateHighlightLayer(pageNumber);
      const labelLayer = this.findOrCreateLabelLayer(pageNumber);

      if (highlightLayer) {
        ReactDom.render(
          <div>
            {(highlightsByPage[String(pageNumber)] || []).map(
              ({ rects, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  rects: this.viewportRectsToScaled(rects),
                  actualPage: pageNumber - 1,
                  ...highlight
                };

                const isScrolledTo = Boolean(scrolledToHighlightId === id);

                return highlightTransform(
                  viewportHighlight,
                  index,
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
              ({ rects, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  rects: this.viewportRectsToScaled(rects),
                  actualPage: pageNumber - 1,
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
              ({ rects, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  rects: this.viewportRectsToScaled(rects),
                  actualPage: pageNumber - 1,
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
              ({ rects, id, ...highlight }, index) => {
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  rects: this.viewportRectsToScaled(rects),
                  actualPage: pageNumber - 1,
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

  renderSelections(nextProps?: Props<T_HT>, range, page, rects) {
    const { selectionTransform } = nextProps || this.props;
    const selectionLayer = this.findOrCreateSelectionLayer(page);

    if (selectionLayer) {
      const sTransform = range ? selectionTransform({ range, page, rects }) : [];

      ReactDom.render(
        <div>
          {sTransform}
        </div>,
        selectionLayer
      );
    }
  }

  clearSelection = (range, startPage) => {
    // this.setState({ selection: null }, this.renderSelections);
    this.renderSelections(this.props, range, startPage);
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

  onTextLayerRendered = () => {
    this.renderNotes();
    this.renderDefinitions();
    this.renderHighlights();
  };

  scrollTo = (highlight: T_Highlight) => {
    const { pages, rects } = highlight.position;
    const pageNumber = pages[0];

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
          scaledToViewport(rects[0], pageViewport).top -
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

    if (selection && selection.baseNode && selection.baseNode.parentNode && (
      selection.baseNode.parentNode.className.includes("definition") ||
      selection.baseNode.parentNode.className.includes("body") ||
      selection.baseNode.parentNode.className.includes("body-title") ||
      selection.baseNode.parentNode.className.includes("body-description") ||
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
    const { onSelectionFinished, withoutSelection } = this.props;

    const { isCollapsed, range } = this.state;

    if (!range || isCollapsed) {
      return;
    }

    const [startPage, endPage] = getPageFromRange(range);


    if (!startPage || !endPage) {
      return;
    }

    const rects = getClientRectsNew(range, [startPage, endPage], this);
    const scaledRects = this.viewportSelectionRectsToScaled(rects);

    // const rects = getClientRects(range, fromPage, true);
    // const rects = getClientRectsNew(range, page, true, this);
    //
    // if (rects.length === 0) {
    //   return;
    // }
    //
    // const boundingRect = getBoundingRect(rects);
    // const viewportPosition = { boundingRect, rects, pageNumber: page.number };
    //
    // console.log("test, ", "afterSelection --- ", boundingRect, viewportPosition);
    //
    // const content = {
    //   text: range.toString()
    // };
    // const scaledPosition = this.viewportPositionToScaled(viewportPosition);
    //
    // if (!withoutSelection) {
    //   this.setState({ selection: { position: scaledPosition } }, this.renderSelections);
    //   window.getSelection().removeAllRanges();
    // }

    onSelectionFinished({ range, startPage, endPage, rects: scaledRects });
    this.renderSelections(this.props, range, startPage.number, scaledRects);
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
    return (
      <Pointable onPointerDown={this.onMouseDown}>
        <div
          ref={this.attachRef}
          className="PdfHighlighter"
          onContextMenu={e => e.preventDefault()}
        >
          <div className="pdfViewer" />
        </div>
      </Pointable>
    );
  }
}

export default PdfHighlighter;
