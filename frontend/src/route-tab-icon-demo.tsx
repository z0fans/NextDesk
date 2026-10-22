/* eslint-disable react-refresh/only-export-components -- Standalone demo entry point; not imported by the application. */
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { Cable, CloudLightning, Network, X } from 'lucide-react';
import './index.css';
import './route-tab-icon-demo.css';

type RouteKind = 'lan' | 'direct' | 'cloud';

const ROUTES: Record<RouteKind, { icon: ComponentType<{ className?: string; strokeWidth?: number }>; label: string; detail: string }> = {
  lan: { icon: Network, label: '局域网', detail: 'LAN Direct' },
  direct: { icon: Cable, label: '直连', detail: 'Local Direct' },
  cloud: { icon: CloudLightning, label: '加速', detail: 'Cloud Accelerated' },
} as const;

function Tab({ name, route, active }: { name: string; route: RouteKind; active?: boolean }) {
  const config = ROUTES[route];
  const Icon = config.icon;
  return (
    <div className={`tab ${active ? 'active' : ''}`}>
      <span className={`route-icon ${route}`} title={config.detail}>
        <Icon className="icon" strokeWidth={2} />
      </span>
      <span className="name">{name}</span>
      <span className={`route-label ${route}`}>{config.label}</span>
      <button aria-label={`关闭 ${name}`}><X className="close" strokeWidth={2} /></button>
    </div>
  );
}

function App() {
  return (
    <main>
      <header>
        <h1>三种线路状态 Demo</h1>
        <p>服务器名称与线路状态分开显示，图标和短文字共同表达，避免用户猜测。</p>
      </header>

      <section className="recommended">
        <div className="heading">
          <div><strong>推荐显示方式</strong><span className="badge">图标 + 短标签</span></div>
          <p>标签处于激活状态时使用浅灰底，线路颜色保持不变。</p>
        </div>
        <div className="tabbar wide">
          <Tab name="办公室电脑" route="lan" />
          <Tab name="Public Server" route="direct" />
          <Tab name="Cloud Desktop" route="cloud" active />
        </div>
      </section>

      <section>
        <div className="heading">
          <div><strong>线路含义</strong></div>
          <p>鼠标悬停图标时显示完整英文线路名称。</p>
        </div>
        <div className="legend">
          <div><span className="route-icon lan"><Network className="icon" /></span><b>局域网</b><small>LAN Direct</small></div>
          <div><span className="route-icon direct"><Cable className="icon" /></span><b>直连</b><small>Local Direct</small></div>
          <div><span className="route-icon cloud"><CloudLightning className="icon" /></span><b>加速</b><small>Cloud Accelerated</small></div>
        </div>
      </section>

      <footer>名称负责识别服务器 · 图标和短标签负责识别当前线路</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
