// @flow

import type { T_LTWH } from "../types.js";

const getClientRectsNew = (
  range: Range,
  pages,
  pdfViewer
): Array<T_LTWH> => {
  const clientRects = Array.from(range.getClientRects());
  const [startPage, endPage] = pages;
  
  const filteredRects = clientRects.filter(el => el.height > 0 && el.height < 100);
  const result = [];
  const startPageView = pdfViewer.viewer.getPageView(startPage.number - 1);
  const endPageView = pdfViewer.viewer.getPageView(endPage.number - 1);
  const fRect = filteredRects[0];
  const lRect = filteredRects[filteredRects.length - 1];
  
  result.push({
    top: fRect.top + startPageView.div.scrollTop - startPageView.div.getBoundingClientRect().top,
    left: fRect.left + startPageView.div.scrollLeft - startPageView.div.getBoundingClientRect().left,
    width: fRect.width,
    height: fRect.height,
    page: startPage.number,
  });

  result.push({
    top: lRect.top + endPageView.div.scrollTop - endPageView.div.getBoundingClientRect().top,
    left: lRect.left + endPageView.div.scrollLeft - endPageView.div.getBoundingClientRect().left,
    width: lRect.width,
    height: lRect.height,
    page: startPage.number,
  });
  
  return result;
};

export default getClientRectsNew;
