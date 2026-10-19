import { subscribeToTicker } from "@/lib/animation/ticker";

/**
 * One frame loop for the sheet stack (StackBlock, FooterReveal): every block
 * measures first, then every block writes — one style recalc per frame
 * instead of one per block. Also the block *arrival* signal reveals wait for.
 */

export interface StackJob {
  /** Layout reads only. */
  read: () => void;
  /** DOM writes only. */
  write: () => void;
}

const jobs = new Set<StackJob>();
let stop: (() => void) | null = null;

const frame = () => {
  const list = [...jobs];
  for (const job of list) job.read();
  for (const job of list) job.write();
};

export const onStackFrame = (job: StackJob): (() => void) => {
  jobs.add(job);
  stop ??= subscribeToTicker(frame, () => 0);
  return () => {
    jobs.delete(job);
    if (jobs.size === 0) {
      stop?.();
      stop = null;
    }
  };
};

/** A block is *arrived* once its visible part reaches the upper third of the screen. */
export const ARRIVAL_LINE = 0.35;
/**
 * A block has *entered* once its visible part reaches this far up the screen —
 * just showing. For reveals that take long enough that, started on arrival,
 * the next sheet would cover them before they finish.
 */
export const ENTER_LINE = 0.9;

const ARRIVE_EVENT = "block:arrive";
const ENTER_EVENT = "block:enter";

/** Latch a block as entered (once) and tell its early reveals. */
export const markEntered = (block: HTMLElement) => {
  if (block.dataset.entered !== undefined) return;
  block.dataset.entered = "";
  block.dispatchEvent(new Event(ENTER_EVENT));
};

/** Latch a block as arrived (once) and tell its reveals. An arrived block has entered too. */
export const markArrived = (block: HTMLElement) => {
  markEntered(block);
  if (block.dataset.arrived !== undefined) return;
  block.dataset.arrived = "";
  block.dispatchEvent(new Event(ARRIVE_EVENT));
};

/** Call `cb` once the block has entered (at once if it already has). */
export const whenEntered = (block: HTMLElement, cb: () => void): (() => void) => {
  if (block.dataset.entered !== undefined) {
    cb();
    return () => {};
  }
  block.addEventListener(ENTER_EVENT, cb, { once: true });
  return () => block.removeEventListener(ENTER_EVENT, cb);
};

/** Call `cb` once the block has arrived (at once if it already has). */
export const whenArrived = (block: HTMLElement, cb: () => void): (() => void) => {
  if (block.dataset.arrived !== undefined) {
    cb();
    return () => {};
  }
  block.addEventListener(ARRIVE_EVENT, cb, { once: true });
  return () => block.removeEventListener(ARRIVE_EVENT, cb);
};
