import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { ConfigService } from '../config/config.service';
import { EventBusService } from '../event-bus/event-bus.service';
import { WhiteboardEvent } from '../types';
import { HistoryService } from './history.service';
import { ViewportHistoryService } from './viewport-history.service';

/**
 * Viewport-in-undo (fork-only, DCN). Kept in a SEPARATE spec file from the upstream
 * `history.service.spec.ts` so re-applying / re-verifying this patch after a lib bump only
 * touches this file — the merge of upstream history tests stays clean.
 */
describe('ViewportHistoryService (viewport-in-undo, fork-only)', () => {
  let tracker: ViewportHistoryService;
  let config: ConfigService;
  let history: HistoryService;
  let eventBus: EventBusService;

  const IDLE = 200;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ConfigService, EventBusService, HistoryService, ViewportHistoryService],
    });
    config = TestBed.inject(ConfigService);
    history = TestBed.inject(HistoryService);
    eventBus = TestBed.inject(EventBusService);
    // Instantiating the tracker wires its ConfigChange subscription (baseline = current viewport).
    tracker = TestBed.inject(ViewportHistoryService);
  });

  /** Drive the tracker the way pan/zoom do at runtime: through ConfigService.updateConfig. */
  function changeViewport(patch: { zoom?: number; x?: number; y?: number }) {
    config.updateConfig(patch);
  }

  it('coalesces a continuous gesture (many frames) into ONE undo entry', fakeAsync(() => {
    // A zoom animation / wheel burst = many updateConfig calls within the idle window.
    changeViewport({ zoom: 1.2 });
    tick(50);
    changeViewport({ zoom: 1.5 });
    tick(50);
    changeViewport({ zoom: 2 });
    expect(history.getCanUndoSignal()()).toBe(false); // nothing committed yet (still mid-gesture)

    tick(IDLE); // gesture settles

    expect(history.getCanUndoSignal()()).toBe(true);
    const step = history.undoEntry();
    expect(step).not.toBeNull();
    // before = viewport at the start of the gesture; after = settled viewport.
    expect(step!.viewport).toEqual({ before: { zoom: 1, x: 0, y: 0 }, after: { zoom: 2, x: 0, y: 0 } });
  }));

  it('undo restores the previous viewport and redo re-applies it — round-trip', fakeAsync(() => {
    changeViewport({ zoom: 3, x: 40, y: -20 });
    tick(IDLE);

    // Simulate ApiService.undo(): read the step, apply its `before`.
    const undoStep = history.undoEntry()!;
    tracker.applyViewport(undoStep.viewport!.before);
    expect(config.getConfig()).toMatchObject({ zoom: 1, x: 0, y: 0 });

    // applyViewport must NOT record a new entry (echo-guarded via updateConfig(vp,false)).
    tick(IDLE);
    expect(history.getCanUndoSignal()()).toBe(false);
    expect(history.getCanRedoSignal()()).toBe(true);

    // Simulate ApiService.redo(): apply the step's `after`.
    const redoStep = history.redoEntry()!;
    tracker.applyViewport(redoStep.viewport!.after);
    expect(config.getConfig()).toMatchObject({ zoom: 3, x: 40, y: -20 });
    tick(IDLE);
    expect(history.getCanUndoSignal()()).toBe(true);
  }));

  it('ignores config changes that do not move the viewport (e.g. stroke colour)', fakeAsync(() => {
    config.updateConfig({ strokeColor: '#ff0000' });
    tick(IDLE);
    expect(history.getCanUndoSignal()()).toBe(false);
  }));

  it('reset() drops an in-flight gesture so a baseline/clear does not leave a stale entry', fakeAsync(() => {
    changeViewport({ zoom: 1.8 });
    tick(50); // gesture started but not yet committed
    tracker.reset();
    tick(IDLE);
    expect(history.getCanUndoSignal()()).toBe(false);
  }));

  it('two separated gestures produce two entries', fakeAsync(() => {
    changeViewport({ x: 100 });
    tick(IDLE);
    changeViewport({ x: 250 });
    tick(IDLE);

    const first = history.undoEntry()!;
    expect(first.viewport!.after.x).toBe(250);
    expect(first.viewport!.before.x).toBe(100);
    const second = history.undoEntry()!;
    expect(second.viewport!.after.x).toBe(100);
    expect(second.viewport!.before.x).toBe(0);
  }));

  it('applyViewport with emit fires ConfigChange but records no entry, and re-baselines', fakeAsync(() => {
    // Programmatic layout fit (fit-on-open / fit-on-resize): emit=true so the OnPush canvas
    // re-renders / live-broadcasts, yet the `applying` guard must keep it OUT of the undo stack.
    const seen: unknown[] = [];
    const sub = eventBus.on(WhiteboardEvent.ConfigChange).subscribe((c) => seen.push(c));

    tracker.applyViewport({ zoom: 0.5, x: 30, y: 15 }, true);
    expect(config.getConfig()).toMatchObject({ zoom: 0.5, x: 30, y: 15 });
    expect(seen.length).toBe(1); // ConfigChange DID fire (emit=true)
    tick(IDLE);
    expect(history.getCanUndoSignal()()).toBe(false); // ...but nothing recorded (echo-guarded)

    // The next real gesture must diff against the FITTED view, not the pre-fit baseline.
    changeViewport({ zoom: 2 });
    tick(IDLE);
    const step = history.undoEntry()!;
    expect(step.viewport!.before).toEqual({ zoom: 0.5, x: 30, y: 15 });
    expect(step.viewport!.after).toEqual({ zoom: 2, x: 30, y: 15 });
    sub.unsubscribe();
  }));

  it('brackets a pointer drag into ONE entry committed on pointer-up (survives mid-drag pauses)', fakeAsync(() => {
    window.dispatchEvent(new Event('pointerdown'));
    changeViewport({ x: 50 });
    tick(IDLE + 100); // a pause LONGER than the idle window — must NOT commit while pointer is down
    changeViewport({ x: 120 });
    tick(IDLE + 100);
    expect(history.getCanUndoSignal()()).toBe(false); // still one open gesture, nothing committed

    window.dispatchEvent(new Event('pointerup'));
    expect(history.getCanUndoSignal()()).toBe(true); // committed on release
    const step = history.undoEntry()!;
    expect(step.viewport!.before.x).toBe(0);
    expect(step.viewport!.after.x).toBe(120); // whole drag = single entry (0 → 120)
  }));

  it('flushes a pending non-pointer gesture when a new drag starts (no merge across gestures)', fakeAsync(() => {
    changeViewport({ zoom: 1.5 }); // wheel-like change, idle timer pending
    tick(50);
    window.dispatchEvent(new Event('pointerdown')); // a drag begins before the idle commit
    changeViewport({ x: 200 });
    window.dispatchEvent(new Event('pointerup'));

    // Two distinct entries: the wheel zoom (flushed on pointerdown) and the drag (flushed on up).
    const drag = history.undoEntry()!;
    expect(drag.viewport!.after).toMatchObject({ zoom: 1.5, x: 200 });
    expect(drag.viewport!.before).toMatchObject({ zoom: 1.5, x: 0 });
    const zoom = history.undoEntry()!;
    expect(zoom.viewport!.after).toMatchObject({ zoom: 1.5, x: 0 });
    expect(zoom.viewport!.before).toMatchObject({ zoom: 1, x: 0 });
  }));

  it('leaves element entries untouched (no viewport payload; undo returns the before-state)', () => {
    // Add element 'b' on top of 'a' → undo should restore the before-state ([a]) with no viewport.
    history.recordChange([{ id: 'a' } as never], [{ id: 'a' } as never, { id: 'b' } as never], 'Create element');
    const step = history.undoEntry()!;
    expect(step.viewport).toBeUndefined();
    expect(step.elements).toEqual([{ id: 'a' }]);
  });
});
