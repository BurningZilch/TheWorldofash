<script lang="ts">
  import { onMount } from 'svelte';

  type Theme = 'light' | 'dark';
  const STORAGE_KEY = 'theworldofash-theme';

  const isValidTheme = (value: string | null): value is Theme =>
    value === 'light' || value === 'dark';

  let theme: Theme = 'light';

  if (typeof document !== 'undefined') {
    const current = document.documentElement.getAttribute('data-theme');
    if (isValidTheme(current)) {
      theme = current;
    }
  }

  const applyTheme = (next: Theme) => {
    const root = document.documentElement;
    root.setAttribute('data-theme', next);
  };

  onMount(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const rootTheme = document.documentElement.getAttribute('data-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

      const initial = isValidTheme(stored)
        ? stored
        : isValidTheme(rootTheme)
        ? rootTheme
        : prefersDark.matches
        ? 'dark'
        : 'light';

      theme = initial;
      applyTheme(theme);

      const handlePreference = (event: MediaQueryListEvent) => {
        const persisted = window.localStorage.getItem(STORAGE_KEY);
        if (!isValidTheme(persisted)) {
          theme = event.matches ? 'dark' : 'light';
          applyTheme(theme);
        }
      };

      prefersDark.addEventListener?.('change', handlePreference);

      return () => prefersDark.removeEventListener?.('change', handlePreference);
    } catch (error) {
      console.warn('Theme preference unavailable', error);
    }
  });

  const toggleTheme = () => {
    theme = theme === 'dark' ? 'light' : 'dark';

    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      console.warn('Unable to persist theme preference', error);
    }

    applyTheme(theme);
  };

  $: label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
</script>

<button
  type="button"
  class="theme-toggle"
  on:click={toggleTheme}
  aria-label={label}
  title={label}
>
  <span class="icon" aria-hidden="true">
    {#if theme === 'dark'}
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path
          fill="currentColor"
          d="M21 12.79A9 9 0 0 1 11.21 3a7 7 0 1 0 9.79 9.79z"
        />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="5" fill="currentColor" />
        <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="3" x2="12" y2="1" />
          <line x1="12" y1="23" x2="12" y2="21" />
          <line x1="4.22" y1="4.22" x2="2.81" y2="2.81" />
          <line x1="21.19" y1="21.19" x2="19.78" y2="19.78" />
          <line x1="3" y1="12" x2="1" y2="12" />
          <line x1="23" y1="12" x2="21" y2="12" />
          <line x1="4.22" y1="19.78" x2="2.81" y2="21.19" />
          <line x1="21.19" y1="2.81" x2="19.78" y2="4.22" />
        </g>
      </svg>
    {/if}
  </span>
</button>

<style>
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--border-color);
    background: var(--surface);
    color: var(--heading-color);
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease,
      box-shadow 0.2s ease;
  }

  .theme-toggle:hover,
  .theme-toggle:focus-visible {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(35, 55, 255, 0.25);
  }

  .theme-toggle:focus-visible {
    outline: none;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .icon svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  @media (max-width: 720px) {
    .theme-toggle {
      padding: 0.4rem;
      font-size: 0.85rem;
    }

    .icon svg {
      width: 1.1rem;
      height: 1.1rem;
    }
  }
</style>
