/* MediVia i18n — small, dependency-free internationalization layer. */
(() => {
  const SUPPORTED = ['en', 'ar'];
  const DEFAULT_LANG = 'en';
  const STORAGE_KEY = 'medivia-language';
  const base = new URL('./', document.baseURI);

  const normalizeLang = (value) => {
    const code = String(value || '').toLowerCase().split('-')[0];
    return SUPPORTED.includes(code) ? code : null;
  };

  async function loadTranslations() {
    const entries = await Promise.all(
      SUPPORTED.map(async (lang) => {
        const response = await fetch(new URL(`locales/${lang}.json`, base));
        if (!response.ok) throw new Error(`Failed to load ${lang}.json (${response.status})`);
        return [lang, await response.json()];
      })
    );
    return Object.fromEntries(entries);
  }

  const get = (obj, path) => {
    if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
    return path.split('.').reduce((value, part) => value?.[part], obj);
  };

  function interpolate(value, vars = {}) {
    return String(value).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
    });
  }

  async function init() {
    const translations = await loadTranslations();
    let lang = normalizeLang(new URLSearchParams(location.search).get('lang'));
    if (!lang) lang = normalizeLang(localStorage.getItem(STORAGE_KEY));
    if (!lang && /^ar\b/i.test(navigator.language || '')) lang = 'ar';
    if (!lang) lang = DEFAULT_LANG;

    const t = (key, vars = {}) => {
      const value = get(translations[lang], key) ?? get(translations[DEFAULT_LANG], key);
      if (value == null) return key;
      return interpolate(value, vars);
    };

    const apply = () => {
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      document.documentElement.dataset.lang = lang;

      document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.dataset.i18n);
      });
      document.querySelectorAll('[data-i18n-html]').forEach((el) => {
        el.innerHTML = t(el.dataset.i18nHtml);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
      });
      document.querySelectorAll('[data-i18n-content]').forEach((el) => {
        el.setAttribute('content', t(el.dataset.i18nContent));
      });
      document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
      });
      document.querySelectorAll('[data-lang]').forEach((button) => {
        button.setAttribute('aria-pressed', button.dataset.lang === lang ? 'true' : 'false');
      });

      // Keep the treatment toggle semantically correct after a language switch.
      document.querySelectorAll('.tcard').forEach((card) => {
        const button = card.querySelector('.tmore');
        if (!button) return;
        button.textContent = card.classList.contains('open') ? t('common.readLess') : t('common.readMore');
      });

      document.dispatchEvent(new CustomEvent('medivia:languagechange', { detail: { lang } }));
    };

    const setLanguage = (next) => {
      const normalized = normalizeLang(next);
      if (!normalized || normalized === lang) {
        if (normalized) apply();
        return;
      }
      lang = normalized;
      localStorage.setItem(STORAGE_KEY, lang);
      apply();
    };

    window.t = t;
    window.getLanguage = () => lang;
    window.setLanguage = setLanguage;
    window.supportedLanguages = [...SUPPORTED];

    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-lang]');
      if (!button) return;
      setLanguage(button.dataset.lang);
    });

    apply();
    return { t, setLanguage, getLanguage: () => lang, translations };
  }

  window.i18nReady = init().catch((error) => {
    console.error('[MediVia i18n]', error);
    // The original English HTML remains visible if translation files cannot be loaded.
    return null;
  });
})();
