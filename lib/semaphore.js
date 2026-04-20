// Semaphore — limits concurrent AI calls globally.
// Extracted from server.js — behavior unchanged.
class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  acquire() {
    return new Promise(resolve => {
      if (this.count < this.max) { this.count++; resolve(); }
      else this.queue.push(resolve);
    });
  }
  release() {
    // Hand slot directly to next waiter if any — count stays the same.
    if (this.queue.length) { this.queue.shift()(); return; }
    // Otherwise free the slot, clamped at 0 to survive unbalanced releases.
    this.count = Math.max(0, this.count - 1);
  }
}

module.exports = { Semaphore };
