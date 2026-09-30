export interface Refresher {
  refresh(): number;
}

export class Session implements Refresher {
  private count = 0;

  refresh(): number {
    this.count += 1;
    return this.count;
  }
}
