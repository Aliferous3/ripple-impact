import { computeTotal as totalWithTax } from "./foo.js";

export function priceForDisplay(price: number): number {
  return totalWithTax(price);
}
