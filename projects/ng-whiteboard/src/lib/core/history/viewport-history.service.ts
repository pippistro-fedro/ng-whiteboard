import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConfigService } from '../config/config.service';
import { EventBusService } from '../event-bus/event-bus.service';
import { WhiteboardEvent } from '../types';
import { HistoryService, Viewport } from './history.service';

/**
 * Records pan/zoom changes as linear undo entries (fork-only, DCN). Upstream keeps navigation out
 * of history; DCN wants "zoom = crop" (WYSIWYG export) undoable alongside drawing, in one stack.
 *
 * All viewport changes funnel through `ConfigService.updateConfig`, which fires `ConfigChange` —
 * but per frame (zoom animation loop, per-pointermove pan, per wheel tick). We coalesce a
 * continuous gesture into a SINGLE entry ("one gesture = one undo") by two complementary means:
 *
 *  1. **Pointer bracketing** — while a pointer is down (a hand-tool pan / drag) NO entry is
 *     committed, and the whole drag is flushed as one entry on pointer-up. This keeps a slow or
 *     paused drag from being split into several entries (a plain idle timer would commit during a
 *     mid-drag pause). The gesture boundary is the button, not a timeout.
 *  2. **Idle debounce** — sources with no pointer up/down (mouse-wheel zoom, the zoom buttons'
 *     animation) commit `IDLE_MS` after the last change. This is the fallback when bracketing
 *     can't apply.
 *
 * Undo/redo restore the view via {@link applyViewport}, which uses `updateConfig(vp, false)` to
 * suppress `ConfigChange` — so replaying history never echoes back as a new recorded change.
 */
@Injectable()
export class ViewportHistoryService implements OnDestroy {
  private configService = inject(ConfigService);
  private eventBus = inject(EventBusService);
  private historyService = inject(HistoryService);

  /** Idle gap (ms) after the last viewport change before a NON-pointer gesture is committed. */
  private readonly IDLE_MS = 200;

  /** Last committed viewport — the baseline a new gesture's `before` is taken from. */
  private last: Viewport = this.snapshot();
  /** Viewport at the start of the in-progress gesture (null when idle). */
  private pendingBefore: Viewport | null = null;
  private pendingAfter: Viewport | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** True while we replay a viewport during undo/redo, so we don't re-record our own change. */
  private applying = false;
  /** True while a pointer is pressed — the gesture is bracketed by pointer up/down, not the timer. */
  private pointerDown = false;

  private sub: Subscription;
  private readonly onPointerDown = () => {
    // A new drag begins: flush any pending non-pointer gesture so it isn't merged into this drag.
    if (this.pendingBefore) this.commit();
    this.pointerDown = true;
  };
  private readonly onPointerUp = () => {
    this.pointerDown = false;
    // Commit the whole drag as one entry, regardless of any mid-drag pauses.
    if (this.pendingBefore) this.commit();
  };

  constructor() {
    this.sub = this.eventBus.on(WhiteboardEvent.ConfigChange).subscribe(() => this.onConfigChange());
    // Capture phase + window so we still see the release even if the pan handler captured the
    // pointer or stopped propagation. Guarded for non-browser (SSR) environments.
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onPointerDown, true);
      window.addEventListener('pointerup', this.onPointerUp, true);
      window.addEventListener('pointercancel', this.onPointerUp, true);
    }
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    this.clearTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.onPointerDown, true);
      window.removeEventListener('pointerup', this.onPointerUp, true);
      window.removeEventListener('pointercancel', this.onPointerUp, true);
    }
  }

  /**
   * Apply a viewport WITHOUT recording an undo entry (echo-guarded), and re-baseline `last` so a
   * later gesture diffs against this view. Used by undo/redo (replay) and by programmatic layout
   * fits (fit-on-open/resize) via the public API.
   *
   * `emit` controls whether `ConfigChange` fires. Recording is prevented by the `applying` flag
   * regardless (our own subscriber runs synchronously while it's set and bails out), so emitting is
   * safe. Undo/redo replay stays silent (`false`) — the surrounding user action already triggers a
   * render; programmatic fits pass `true` because their callers (ResizeObserver / init timers) run
   * OUTSIDE Angular's event flow, and the lib's OnPush re-render on resize is driven by the
   * `ConfigChange` round-trip (mirrors the pre-existing `updateConfig` path they replaced).
   */
  applyViewport(vp: Viewport, emit = false): void {
    this.applying = true;
    this.configService.updateConfig({ zoom: vp.zoom, x: vp.x, y: vp.y }, emit);
    this.last = { ...vp };
    this.resetPending();
    this.applying = false;
  }

  /** Re-sync the baseline to the current viewport and drop any in-flight gesture. Call when the
   *  history is cleared (e.g. a new board / baseline load) so stale gestures don't get committed. */
  reset(): void {
    this.last = this.snapshot();
    this.resetPending();
  }

  private onConfigChange(): void {
    if (this.applying) return;
    const vp = this.snapshot();
    if (this.sameAs(vp, this.last)) return; // no viewport delta (e.g. a stroke-colour change)
    if (this.pendingBefore === null) this.pendingBefore = { ...this.last };
    this.pendingAfter = vp;
    this.clearTimer();
    // While a pointer is down the gesture is bracketed by pointer-up (see onPointerUp) — don't arm
    // the idle timer, so a paused drag stays a single entry. Otherwise fall back to the debounce.
    if (!this.pointerDown) this.timer = setTimeout(() => this.commit(), this.IDLE_MS);
  }

  private commit(): void {
    const before = this.pendingBefore;
    const after = this.pendingAfter;
    this.resetPending();
    if (!before || !after) return;
    this.historyService.recordViewportChange(before, after);
    this.last = after;
  }

  private resetPending(): void {
    this.pendingBefore = null;
    this.pendingAfter = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private snapshot(): Viewport {
    const c = this.configService.getConfig();
    return { zoom: c.zoom, x: c.x, y: c.y };
  }

  private sameAs(a: Viewport, b: Viewport): boolean {
    return a.zoom === b.zoom && a.x === b.x && a.y === b.y;
  }
}
