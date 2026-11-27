export class ScrollbackClearFilter {
  push(chunk: string): string;
  flush(): string;
  reset(): void;
}
