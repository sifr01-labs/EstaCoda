import type {ReactNode} from 'react';
import '../styles/loading.css';

/** Decorative only. The caller owns the localized status and execution state. */
export function ActivityIndicator({variant = 'orbit'}: {variant?: 'dots' | 'orbit'}) {
  return <span className="ec-activity-indicator" aria-hidden="true">
    {variant === 'dots'
      ? <span className="ec-loading-dots"><i/><i/><i/></span>
      : <span className="ec-loading-orbit"><span className="ec-loading-satellites"><i/><i/><i/></span></span>}
  </span>;
}

export function LoadingStatus({children}: {children: ReactNode}) {
  return <p className="ec-loading-status" role="status"><ActivityIndicator/>{children}</p>;
}

/** Fixed specimen geometry from the approved refined prototype; no fake content. */
export function SkeletonRows({label, rows = 2}: {label: string; rows?: number}) {
  return <div className="ec-loading-rows">
    <span className="ec-sr-only" role="status">{label}</span>
    <div className="ec-loading-delayed" aria-hidden="true">
      {Array.from({length: rows}, (_, index) => <div className="ec-loading-row" key={index}>
        <span className="ec-loading-file-icon"><span className="ec-loading-bone-icon"/></span>
        <span className="ec-loading-lines">
          <span className="ec-loading-bone" style={{width: index % 2 ? 112 : 169}}/>
          <span className="ec-loading-bone" style={{width: index % 2 ? 90 : 95}}/>
        </span>
      </div>)}
    </div>
  </div>;
}
