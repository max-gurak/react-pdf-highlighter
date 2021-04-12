// @flow

export const getDocument = (elm: any): Document =>
  (elm || {}).ownerDocument || document;
export const getWindow = (elm: any): typeof window =>
  (getDocument(elm) || {}).defaultView || window;
export const isHTMLElement = (elm: any) =>
  elm instanceof HTMLElement || elm instanceof getWindow(elm).HTMLElement;
export const isHTMLCanvasElement = (elm: any) =>
  elm instanceof HTMLCanvasElement ||
  elm instanceof getWindow(elm).HTMLCanvasElement;
export const asElement = (x: any): HTMLElement => (x: HTMLElement);

export const getPageFromElement = (target: HTMLElement) => {
  const node = asElement(target.closest(".page"));

  if (!node || !isHTMLElement(node)) {
    return null;
  }

  const number = Number(asElement(node).dataset.pageNumber);

  return { node, number };
};

export const getPageFromRange = (range: Range) => {
  const startParentElement = range.startContainer.parentElement;
  const endParentElement = range.endContainer.parentElement;

  if (!isHTMLElement(startParentElement) || !isHTMLElement(endParentElement)) {
    return;
  }

  return [getPageFromElement(asElement(startParentElement)), getPageFromElement(asElement(endParentElement))];
};

export const findOrCreateContainerLayer = (
  container: HTMLElement,
  className: string
) => {
  const doc = getDocument(container);
  let layer = container.querySelector(`.${className}`);

  if (!layer) {
    layer = doc.createElement("div");
    layer.className = className;
    container.appendChild(layer);
  }

  return layer;
};
