import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Campaign, Expert } from '../api';
import { notify } from '../toast';
import { navigate } from '../useHashRoute';

interface Item {
  id: string;
  label: string;
  /** the quiet word on the right: what kind of row this is */
  kind: string;
  run: () => void;
}

interface Props {
  experts: Expert[];
  identityId: string;
  onIdentity: (id: string) => void;
  onClose: () => void;
}

/** Ctrl+K palette. Mounted only while open, so every opening starts clean. */
export function CommandPalette({ experts, identityId, onIdentity, onClose }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  // 'root' lists destinations and actions; 'identity' lists who you can be
  const [page, setPage] = useState<'root' | 'identity'>('root');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    api
      .get<Campaign[]>('/api/campaigns')
      .then((rows) => {
        if (live) setCampaigns(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Take focus on open; hand it back on close if its owner is still on the page.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const items = useMemo<Item[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    if (page === 'identity') {
      return experts.map((x) => ({
        id: `expert:${x.id}`,
        label: x.name,
        kind: x.id === identityId ? 'current' : x.domain,
        run: () => {
          onIdentity(x.id);
          notify(`You are ${x.name}`);
          onClose();
        },
      }));
    }
    return [
      { id: 'go:campaigns', label: 'Campaigns', kind: 'go to', run: go('/campaigns') },
      { id: 'go:author', label: 'Author task', kind: 'go to', run: go('/author') },
      { id: 'go:review', label: 'Review', kind: 'go to', run: go('/review') },
      ...campaigns.map((c) => ({
        id: `campaign:${c.id}`,
        label: c.name,
        kind: 'campaign',
        run: go(`/campaigns/${c.id}`),
      })),
      {
        id: 'do:identity',
        label: 'Switch identity',
        kind: 'action',
        run: () => {
          setPage('identity');
          setQuery('');
          setActive(0);
        },
      },
    ];
  }, [page, campaigns, experts, identityId, onIdentity, onClose]);

  const needle = query.trim().toLowerCase();
  const shown = needle ? items.filter((it) => `${it.label} ${it.kind}`.toLowerCase().includes(needle)) : items;
  // the list can shrink under the cursor (typing, campaigns arriving)
  const current = Math.min(active, shown.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current, shown.length]);

  function back() {
    setPage('root');
    setQuery('');
    setActive(0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Nothing typed here may reach the views' own shortcuts (J/K, Ctrl+Enter).
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      onClose();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (shown.length) setActive((current + 1) % shown.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (shown.length) setActive((current - 1 + shown.length) % shown.length);
        break;
      case 'Home':
        if (!query) setActive(0);
        break;
      case 'End':
        if (!query) setActive(Math.max(0, shown.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (!e.repeat) shown[current]?.run();
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'Backspace':
        if (page === 'identity' && !query) {
          e.preventDefault();
          back();
        }
        break;
      case 'Tab':
        // the input is the only stop; keep focus inside the dialog
        e.preventDefault();
        break;
    }
  }

  const activeId = shown[current] ? `cmd-${shown[current].id}` : undefined;

  return (
    <div
      className="cmd-layer"
      onMouseDown={(e) => {
        // Only the input may hold focus: a click elsewhere must not blur it,
        // or the keyboard would fall through to the view underneath.
        if (e.target !== inputRef.current) e.preventDefault();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmd" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="cmd-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label={page === 'identity' ? 'Switch identity to' : 'Search destinations and actions'}
          placeholder={page === 'identity' ? 'Switch identity to…' : 'Go to or do…'}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul id="cmd-list" ref={listRef} className="cmd-rows" role="listbox" aria-label="Results">
          {shown.map((it, i) => (
            <li
              key={it.id}
              id={`cmd-${it.id}`}
              className="cmd-row"
              role="option"
              aria-selected={i === current}
              // keep focus in the input; the click still selects
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => {
                if (i !== current) setActive(i);
              }}
              onClick={it.run}
            >
              <span className="cmd-row-label">{it.label}</span>
              <span className="cmd-row-kind">{it.kind}</span>
            </li>
          ))}
        </ul>
        {shown.length === 0 && (
          <p className="cmd-none">
            {page === 'identity' && experts.length === 0 ? 'No experts to switch to' : 'No matches'}
          </p>
        )}
        <p className="cmd-keys" aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd> select · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}
