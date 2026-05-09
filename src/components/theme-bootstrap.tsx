// Inline script para aplicar tema + estado do rail antes do hydration (no FOUC)
export function ThemeBootstrap() {
  const code = `(function(){try{var t=localStorage.getItem('fabric-theme')||'dark';document.documentElement.dataset.theme=t;var r=localStorage.getItem('fabric-rail')||'collapsed';document.documentElement.dataset.rail=r;}catch(e){document.documentElement.dataset.theme='dark';document.documentElement.dataset.rail='collapsed';}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
