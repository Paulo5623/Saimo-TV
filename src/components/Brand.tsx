import './Brand.css';
import { useId } from 'react';

export function Brand({size='compact',tagline,iconOnly=false}:{size?:'compact'|'hero';tagline?:string;iconOnly?:boolean}){
  const gradientId=useId().replaceAll(':','');
  return <div className={`tv-brand ${size}`} aria-label="TV Ligada">
    <svg className="tv-brand-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="5" y="8" width="38" height="29" rx="8" fill={`url(#${gradientId})`}/>
      <path d="M20 17.5 32 23 20 28.5v-11Z" fill="#071013"/>
      <path d="M15 42h18M24 37v5" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
      <path d="M36 13.5a5.5 5.5 0 0 1 0 11" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".8"/>
      <defs><linearGradient id={gradientId} x1="6" y1="8" x2="42" y2="37" gradientUnits="userSpaceOnUse"><stop stopColor="#29e58c"/><stop offset="1" stopColor="#45a8ff"/></linearGradient></defs>
    </svg>
    {!iconOnly&&<span className="tv-brand-copy"><b>TV</b> <strong>Ligada</strong>{tagline&&<small>{tagline}</small>}</span>}
  </div>
}
