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
  $: icon = theme === 'dark' ? '🌙' : '☀️';
</script>

<button
  type="button"
  class="theme-toggle"
  on:click={toggleTheme}
  aria-label={label}
  title={label}
>
  <span aria-hidden="true">{icon}</span>
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

  @media (max-width: 720px) {
    .theme-toggle {
      padding: 0.4rem;
      font-size: 0.85rem;
    }
  }
</style>
