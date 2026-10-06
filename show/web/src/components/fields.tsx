// Form controls drawn from the server's vocabulary (ParamSpec). Each commits
// on release / blur / Enter, not on every keystroke, so one change is one
// edit and one undo step.

import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Aim, ParamSpec, Vec3 } from '@/types';

const UNSET = '__unset';

export function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  const name = <span className="truncate text-xs text-muted-foreground">{label}</span>;
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2 py-1">
      {help ? (
        <Tooltip>
          <TooltipTrigger asChild><span className="cursor-help">{name}</span></TooltipTrigger>
          <TooltipContent side="left" className="max-w-72">{help}</TooltipContent>
        </Tooltip>
      ) : name}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border-b border-border/60 px-3 py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ClearButton({ onClear }: { onClear: () => void }) {
  return (
    <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground" title="Unset — let the layer below decide" onClick={onClear}>
      <X className="size-3.5" />
    </Button>
  );
}

/** A number typed or dragged; commits on release or blur. */
export function NumberInput({ value, onCommit, step = 0.01, min, max, placeholder, className }: {
  value: number | undefined; onCommit: (v: number | null) => void; step?: number; min?: number; max?: number; placeholder?: string; className?: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  const commit = () => {
    if (text.trim() === '') { if (value != null) onCommit(null); return; }
    const n = Number(text);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setText(value == null ? '' : String(value));
  };
  return (
    <Input type="number" inputMode="decimal" step={step} min={min} max={max} value={text} placeholder={placeholder}
      className={className ?? 'h-7 w-20 px-2 text-xs tabular-nums'}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

export function NumberField({ spec, value, onCommit, clearable }: { spec: ParamSpec; value: number | undefined; onCommit: (v: number | null) => void; clearable?: boolean }) {
  const shown = value ?? (spec.default as number | undefined) ?? spec.min ?? 0;
  const [drag, setDrag] = useState<number | null>(null);
  const max = spec.unit === '°' ? Math.min(spec.max ?? 360, 360) : spec.max ?? 1;
  return (
    <div className="flex items-center gap-2">
      <Slider className={value == null ? 'flex-1 opacity-40' : 'flex-1'} min={spec.min ?? 0} max={max} step={spec.step ?? 0.01}
        value={[drag ?? shown]} onValueChange={([v]) => setDrag(v)} onValueCommit={([v]) => { setDrag(null); onCommit(v); }} />
      <NumberInput value={drag ?? value} onCommit={onCommit} step={spec.step} min={spec.min} max={spec.max} placeholder={spec.default != null ? String(spec.default) : '—'} />
      {spec.unit && <span className="w-8 text-[11px] text-muted-foreground">{spec.unit}</span>}
      {clearable && value != null && <ClearButton onClear={() => onCommit(null)} />}
    </div>
  );
}

export function EnumField({ options, value, onCommit, placeholder = '—', swatches }: {
  options: string[]; value: string | undefined; onCommit: (v: string | null) => void; placeholder?: string; swatches?: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Select value={value ?? UNSET} onValueChange={(v) => onCommit(v === UNSET ? null : v)}>
        <SelectTrigger size="sm" className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {swatches?.[o] && <span className="inline-block size-2.5 rounded-full" style={{ background: swatches[o] }} />}
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {swatches && (
        <div className="flex gap-1">
          {options.map((o) => (
            <button key={o} title={o} onClick={() => onCommit(o)}
              className={`h-4 flex-1 rounded-sm border-2 ${value === o ? 'border-white' : 'border-transparent'}`} style={{ background: swatches[o] }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChipsField({ options, value, onCommit }: { options: string[]; value: string[] | undefined; onCommit: (v: string[] | null) => void }) {
  return (
    <ToggleGroup type="multiple" variant="outline" size="sm" className="flex flex-wrap justify-start"
      value={value ?? []} onValueChange={(v: string[]) => onCommit(v.length ? options.filter((o) => v.includes(o)) : null)}>
      {options.map((o) => <ToggleGroupItem key={o} value={o} className="h-6 px-2 text-[11px]">{o}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

export function TimeField({ value, hint, onCommit }: { value: number; hint: string; onCommit: (v: number | string) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const raw = text.trim();
    if (!raw || raw === String(value)) return;
    onCommit(/^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
  };
  return (
    <div className="flex flex-col gap-0.5">
      <Input className="h-7 text-xs tabular-nums" value={text} title='Seconds, m:ss, "bar 17", "bar 17.3", a marker label, "+ 2 bars"…'
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}

export function TextField({ value, onCommit, placeholder }: { value: string | undefined; onCommit: (v: string | null) => void; placeholder?: string }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  return (
    <Input className="h-7 text-xs" value={text} placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { const v = text.trim(); if (v !== (value ?? '')) onCommit(v || null); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

export function Vec3Field({ value, onCommit, labels = ['x', 'y', 'z'], step = 0.05 }: { value: Vec3; onCommit: (v: Vec3) => void; labels?: string[]; step?: number }) {
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <label key={i} className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">{labels[i]}</span>
          <NumberInput className="h-7 w-[58px] px-1.5 text-xs tabular-nums" value={value[i]} step={step}
            onCommit={(n) => { if (n == null) return; const next = [...value] as Vec3; next[i] = n; onCommit(next); }} />
        </label>
      ))}
    </div>
  );
}

export function AimField({ value, onCommit, targets, fallback, clearable = true }: {
  value: Aim | undefined; onCommit: (v: Aim | null) => void; targets: string[]; fallback?: unknown; clearable?: boolean;
}) {
  const kind = value == null ? UNSET : typeof value === 'string' ? value : Array.isArray(value) ? '@point' : '@pantilt';
  const fb = fallback && typeof fallback === 'object' && 'pan' in (fallback as object) ? `${(fallback as any).pan}/${(fallback as any).tilt}` : fallback;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Select value={kind} onValueChange={(v) => {
          if (v === UNSET) onCommit(null);
          else if (v === '@pantilt') onCommit({ pan: 0, tilt: 40 });
          else if (v === '@point') onCommit([0, 3, 6]);
          else onCommit(v);
        }}>
          <SelectTrigger size="sm" className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>{fb ? `default (${String(fb)})` : '—'}</SelectItem>
            <SelectItem value="home">home</SelectItem>
            <SelectSeparator />
            {targets.map((t) => <SelectItem key={t} value={t}>→ {t}</SelectItem>)}
            <SelectSeparator />
            <SelectItem value="@pantilt">pan / tilt…</SelectItem>
            <SelectItem value="@point">point x y z…</SelectItem>
          </SelectContent>
        </Select>
        {clearable && value != null && <ClearButton onClear={() => onCommit(null)} />}
      </div>
      {kind === '@pantilt' && (
        <Vec3PanTilt value={value as { pan: number; tilt: number }} onCommit={onCommit} />
      )}
      {kind === '@point' && <Vec3Field value={value as Vec3} onCommit={onCommit} />}
    </div>
  );
}

function Vec3PanTilt({ value, onCommit }: { value: { pan: number; tilt: number }; onCommit: (v: Aim) => void }) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1"><span className="text-[10px] text-muted-foreground">pan</span>
        <NumberInput className="h-7 w-16 px-1.5 text-xs" value={value.pan} step={1} onCommit={(n) => n != null && onCommit({ ...value, pan: n })} /></label>
      <label className="flex items-center gap-1"><span className="text-[10px] text-muted-foreground">tilt</span>
        <NumberInput className="h-7 w-16 px-1.5 text-xs" value={value.tilt} step={1} onCommit={(n) => n != null && onCommit({ ...value, tilt: n })} /></label>
    </div>
  );
}

export function AimListField({ value, onCommit, targets }: { value: Aim[] | undefined; onCommit: (v: Aim[] | null) => void; targets: string[] }) {
  const list = value ?? [];
  return (
    <div className="flex flex-col gap-2">
      {list.map((aim, i) => (
        <div key={i} className="flex items-start gap-1">
          <span className="mt-1.5 w-4 text-[10px] text-muted-foreground">{i + 1}</span>
          <div className="flex-1">
            <AimField value={aim} targets={targets} clearable={false} onCommit={(v) => { const next = [...list]; next[i] = v ?? 'home'; onCommit(next); }} />
          </div>
          <ClearButton onClear={() => { const next = list.filter((_, j) => j !== i); onCommit(next.length ? next : null); }} />
        </div>
      ))}
      <Button variant="outline" size="sm" className="h-7 self-start text-xs" onClick={() => onCommit([...list, { pan: 0, tilt: 40 }])}>+ position</Button>
    </div>
  );
}
