// @flow

import type { T_LTWH } from "../types.js";

import optimizeClientRects from "./optimize-client-rects";

const getClientRectsNew = (
  range: Range,
  startElement,
  shouldOptimize: boolean = true,
  pdfViewer
): Array<T_LTWH> => {
  const clientRects = Array.from(range.getClientRects());
  const filteredRects = clientRects.filter(el => el.height > 0 && el.height < 50);
  const result = [];
  let pageNumber = startElement.number - 1;
  let page = pdfViewer.viewer.getPageView(pageNumber);
  let offset = page.div.getBoundingClientRect();
  let maxPagesHeight = page.viewport.height;

  for (let i = 0, l = filteredRects.length; i < l; i++) {
    const rect = filteredRects[i];
    const item = {
      top: rect.top + page.div.scrollTop - offset.top,
      left: rect.left + page.div.scrollLeft - offset.left,
      width: rect.width,
      height: rect.height,
      page: pageNumber,
    };

    if (item.top > maxPagesHeight) {
      pageNumber++;
      page = pdfViewer.viewer.getPageView(pageNumber);
      offset = page.div.getBoundingClientRect();
      maxPagesHeight = page.viewport.height;

      i--;
      continue;
    }

    result.push(item);
  }

  return shouldOptimize ? optimizeClientRects(result) : result;
};

export default getClientRectsNew;
