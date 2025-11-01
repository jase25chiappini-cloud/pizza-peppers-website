import React from 'react';
import { fetchLiveMenu } from '../lib/menuClient';

export default function DebugMenuFetch() {
  const [info, setInfo] = React.useState('starting…');
  const [api, setApi] = React.useState(null);

  React.useEffect(() => {
    console.log('[DebugMenuFetch] mounted');
    (async () => {
      try {
        const data = await fetchLiveMenu(); // already unwrapped (.data)
        console.log('[DebugMenuFetch] fetched ok, keys:', Object.keys(data || {}));
        window.__PP_DEBUG_MENU__ = data;
        const cats = Array.isArray(data?.categories) ? data.categories.length : 0;
        const prods = Array.isArray(data?.products) ? data.products.length : 0;
        setInfo(`OK: categories=${cats}, products=${prods}`);
        setApi(data);
      } catch (e) {
        console.error('[DebugMenuFetch] failed', e);
        setInfo(`ERROR: ${e?.message || e}`);
      }
    })();
  }, []);

  return (
    <div style={{padding:8, border:'1px dashed #888', marginBottom:12, fontFamily:'monospace'}}>
      <div>[DebugMenuFetch] {info}</div>
      {api && (
        <details style={{marginTop:6}}>
          <summary>preview api</summary>
          <pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(api, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

