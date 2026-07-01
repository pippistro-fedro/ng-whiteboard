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
 * but per frame (zoom animation loop, per-pointermove pan, per wheel tick). So we coalesce a
 * continuous gesture into a SINGLE entry: capture the viewport at the start of a burst, and commit
 * one entry once it has been idle for `IDLE_MS` ("one gesture = one undo").
 *
 * Undo/redo restore the view via {@link applyViewport}, which uses `updateConfig(vp, false)` to
 * suppress `ConfigChange` — so replaying history never echoes back as a new recorded change.
 */
@Injectable()
export class ViewportHistoryService implements OnDestroy {
  private configService = inject(ConfigService);
  private eventBus = inject(EventBusService);
  private historyService = inject(HistoryService);

  /** Idle gap (ms) after the last viewport change before a gesture is committed as one entry. */
  private readonly IDLE_MS = 200;

  /** Last committed viewport — the baseline a new gesture's `before` is taken from. */
  private last: Viewport = this.snapshot();
  /** Viewport at the start of the in-progress gesture (null when idle). */
  private pendingBefore: Viewport | null = null;
  private pendingAfter: Viewport | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** True while we replay a viewport during undo/redo, so we don't re-record our own change. */
  private applying = false;

  private sub: Subscription;

  constructor() {
    this.sub = this.eventBus.on(WhiteboardEvent.ConfigChange).subscribe(() => this.onConfigChange());
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    this.clearTimer();
  }

  /** Apply a viewport during undo/redo without recording it (echo-guarded). */
  applyViewport(vp: Viewport): void {
    this.applying = true;
    // `false` suppresses ConfigChange → our own subscriber won't see this as a user gesture.
    this.configService.updateConfig({ zoom: vp.zoom, x: vp.x, y: vp.y }, false);
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
    this.timer = setTimeout(() => this.commit(), this.IDLE_MS);
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
