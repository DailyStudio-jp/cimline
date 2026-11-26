const SCROLLBACK_CLEAR = "\u001b[3J";

/**
 * Removes the xterm scrollback-clear sequence while preserving every other
 * byte represented by the input string. A CSI sequence can be split across
 * PTY events, so a possible suffix is held until the next chunk arrives.
 */
export class ScrollbackClearFilter {
  #pending = "";

  push(chunk) {
    if (typeof chunk !== "string") throw new TypeError("PTY output must be a string");
    if (chunk.length === 0) return "";

    const input = this.#pending + chunk;
    this.#pending = "";
    let output = "";
    let offset = 0;

    while (offset < input.length) {
      if (input.startsWith(SCROLLBACK_CLEAR, offset)) {
        offset += SCROLLBACK_CLEAR.length;
        continue;
      }

      const remaining = input.slice(offset);
      if (SCROLLBACK_CLEAR.startsWith(remaining)) {
        this.#pending = remaining;
        break;
      }

      output += input[offset];
      offset += 1;
    }

    return output;
  }

  /** Return a partial sequence unchanged when the stream is known to be over. */
  flush() {
    const pending = this.#pending;
    this.#pending = "";
    return pending;
  }

  /** Forget any partial sequence before attaching this filter to a new stream. */
  reset() {
    this.#pending = "";
  }
}
