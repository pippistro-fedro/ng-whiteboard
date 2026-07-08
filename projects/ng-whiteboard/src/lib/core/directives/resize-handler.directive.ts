import { ChangeDetectorRef, Directive, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { ApiService } from '../api/api.service';

@Directive({
  selector: '[resizeHandler]',
  standalone: true,
})
export class ResizeHandlerDirective implements OnInit, OnDestroy {
  private resizeObserver!: ResizeObserver;

  constructor(private elementRef: ElementRef, private apiService: ApiService, private _cd: ChangeDetectorRef) {}

  ngOnInit() {
    this.resizeObserver = new ResizeObserver(([entry]) => {
      if (entry.target === this.elementRef.nativeElement) {
        const { fullScreen, center, preserveViewportOnResize } = this.apiService.getConfig();

        setTimeout(() => {
          if (preserveViewportOnResize) {
            // Keep canvas size + zoom/pan as-is: the SVG (100% of the container) rescales the
            // existing viewBox to the new size, so the current view (crop) is preserved and any
            // recorded viewport-undo entries stay coherent. Just re-render for the new size.
            this._cd.detectChanges();
            return;
          }
          if (fullScreen) {
            this.apiService.fullScreen();
          }
          if (center && !fullScreen) {
            this.apiService.centerCanvas();
          }
          this._cd.detectChanges();
        }, 0);
      }
    });
    this.resizeObserver.observe(this.elementRef.nativeElement);
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
  }
}
