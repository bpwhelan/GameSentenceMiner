// @vitest-environment jsdom
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DeferredPanel } from './DeferredPanel';

it('allocates a tool on first use and retains its state across tab changes', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const mount = vi.fn();
  function Tool() {
    const [value, setValue] = useState(0);
    useEffect(mount, []);
    return <button onClick={() => setValue(value + 1)}>{value}</button>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    const render = (active: boolean) => act(async () => root.render(<DeferredPanel active={active}><Tool /></DeferredPanel>));
    await render(false);
    expect(mount).not.toHaveBeenCalled();
    await render(true);
    await act(async () => container.querySelector('button')!.click());
    await render(false);
    await render(true);
    expect(mount).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('1');
  } finally { await act(async () => root.unmount()); }
});
