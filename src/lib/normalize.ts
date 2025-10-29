import { z } from 'zod';

export const Obs = z.object({ date: z.string(), value: z.string() });
export type QuarterRow = {
  period: string; region: string; hyOAS: number; fci: number; pmi: number; dxy: number;
  bookBill: number; defaults: number; unemployment: number; riskScore: number; signal: string;
};

export function toNumber(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
export function quarter(dateISO: string): string { const d = new Date(dateISO); const q = Math.floor(d.getMonth()/3)+1; return `${d.getFullYear()} Q${q}`; }

export function computeScore(x: { hyOAS: number; fci: number; pmi: number; dxy: number; bookBill: number; ur: number }) {
  const clamp = (v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
  const sOAS = clamp((x.hyOAS-250)/(700-250),0,1);
  const sFCI = clamp((x.fci-(-0.8))/(0.6-(-0.8)),0,1);
  const sPMI = clamp((55 - x.pmi)/(55-45),0,1);
  const sDXY = clamp((x.dxy-95)/(110-95),0,1);
  const sBB  = clamp((1.0 - x.bookBill)/(1.0-0.9),0,1);
  const sUR  = clamp((x.ur-3.5)/(8-3.5),0,1);
  const score = 0.25*sOAS + 0.15*sFCI + 0.20*sPMI + 0.10*sDXY + 0.10*sBB + 0.20*sUR;
  return clamp(score,0,1);
}
export function toSignal(score:number){ return score>0.6?'🔴':score>0.35?'🟡':'🟢'; }
