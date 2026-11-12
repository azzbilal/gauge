import { useEffect, useState } from 'react';

export interface Route {
  /** '/campaigns' | '/author' | '/review' */
  path: string;
  /** task id for '/review/:id', campaign id for '/campaigns/:id' */
  param?: string;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '');
  const seg = raw.split('/').filter(Boolean);
  if (seg.length === 0) return { path: '/campaigns' };
  return { path: '/' + seg[0], param: seg[1] };
}

/** Tiny hash router: deep-linkable addresses with no dependency. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string) {
  window.location.hash = path;
}
