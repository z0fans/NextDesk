import type { PointerEvent as ReactPointerEvent } from 'react';

import { cn } from '@/lib/utils';

interface SshResizeHandleProps {
  orientation: 'horizontal' | 'vertical';
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  onChange: (value: number) => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function SshResizeHandle({
  orientation,
  value,
  minimum,
  maximum,
  label,
  onChange,
}: SshResizeHandleProps) {
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startingCoordinate = orientation === 'vertical' ? event.clientX : event.clientY;
    const startingValue = value;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const move = (moveEvent: PointerEvent) => {
      const coordinate = orientation === 'vertical' ? moveEvent.clientX : moveEvent.clientY;
      const delta = coordinate - startingCoordinate;
      onChange(clamp(
        orientation === 'vertical' ? startingValue + delta : startingValue - delta,
        minimum,
        maximum,
      ));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      className={cn(
        'group relative z-10 shrink-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500',
        orientation === 'vertical'
          ? 'w-1.5 cursor-col-resize bg-border/45 hover:bg-cyan-500/35'
          : 'h-1.5 cursor-row-resize bg-border/45 hover:bg-cyan-500/35',
      )}
      onPointerDown={beginResize}
      onKeyDown={(event) => {
        let next = value;
        if (event.key === 'Home') next = minimum;
        if (event.key === 'End') next = maximum;
        if (orientation === 'vertical' && event.key === 'ArrowLeft') next -= 16;
        if (orientation === 'vertical' && event.key === 'ArrowRight') next += 16;
        if (orientation === 'horizontal' && event.key === 'ArrowUp') next += 16;
        if (orientation === 'horizontal' && event.key === 'ArrowDown') next -= 16;
        if (next === value) return;
        event.preventDefault();
        onChange(clamp(next, minimum, maximum));
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute rounded-full bg-muted-foreground/35 transition-colors group-hover:bg-cyan-500 group-focus-visible:bg-cyan-500',
          orientation === 'vertical'
            ? 'left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2'
            : 'left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2',
        )}
      />
    </div>
  );
}
