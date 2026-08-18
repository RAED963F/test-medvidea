# MediVia — Internationalization (i18n)

The site now uses a small, dependency-free internationalization layer for English and Arabic.

## Supported languages

- English — `en` (default)
- Arabic — `ar`

The selected language is stored in `localStorage` under `medivia-language`. A first-time visitor with an Arabic browser may start in Arabic; otherwise English is used. A URL query such as `?lang=ar` can also explicitly select the initial language.

## Translation files

All user-facing translations are centralized in:

```text
locales/
├── en.json
└── ar.json
```

The keys are organized by site area, for example:

```json
{
  "hero": {
    "title": "From First Contact<br>to <em>Full Recovery</em>"
  },
  "booking": {}
}
```

The current project uses keys such as `hero.title`, `form.firstName`, `review.send`, and `treatments.oncology.text`.

## How to change a translation

Find the key used by the element and edit the corresponding value in both language files.

Example:

```json
// locales/en.json
"review.send": "Send my case"
```

Change it to:

```json
"review.send": "Submit my case"
```

Then update the same key in `locales/ar.json`:

```json
"review.send": "أرسل ملفي"
```

You do not need to edit every HTML section that uses the same translation key.

## How to add a new translation key

1. Add the key to `locales/en.json`.
2. Add the identical key to `locales/ar.json`.
3. Put `data-i18n="your.key"` on the HTML element whose text should use it.
4. For an input placeholder, use `data-i18n-placeholder="your.key"`.
5. For an attribute such as `aria-label`, use `data-i18n-aria-label="your.key"`.
6. For small pieces of markup that must remain inside a translation, use `data-i18n-html`. Use this sparingly.

Example:

```html
<h2 data-i18n="hero.title">...</h2>
```

## How to add a new language

Example: Russian (`ru`).

1. Create `locales/ru.json`.
2. Copy the complete key structure from `locales/en.json`.
3. Translate every value.
4. Add `"ru"` to `SUPPORTED` in `js/i18n.js`.
5. Add a Russian button to the language switcher in `index.html`.
6. Test the page in both LTR/RTL and responsive layouts as applicable.

The page does not need separate copies of the HTML for each language.

## RTL

Arabic automatically sets:

```html
<html lang="ar" dir="rtl">
```

English sets:

```html
<html lang="en" dir="ltr">
```

The implementation also includes RTL adjustments for the clinical-path rail and mobile positioning. The existing CSS already uses many logical properties such as `margin-inline`, `padding-inline`, `inset-inline-*`, and `border-inline-*`, so future RTL/LTR maintenance remains simpler.

## Language switching

The switcher changes the language immediately without a full page reload and preserves the user's current form values. The selected language is stored locally so it remains selected on the next visit.

## SEO

The current project is a single static HTML page and does not have a routing framework.

The i18n layer updates:

- `<html lang>`
- `<html dir>`
- `<title>`
- meta description
- Open Graph title/description
- Twitter title/description

No `/en/` or `/ar/` URL structure was introduced because that would require a routing/hosting decision that does not exist in the current project.

For a future SEO-focused multilingual deployment, separate crawlable URLs such as `/en/` and `/ar/` plus canonical/hreflang handling would be preferable. That should be introduced deliberately rather than changing the current URLs without a migration plan.

## Dynamic text

JavaScript-generated user-facing messages use `t()` rather than hard-coded English.

Example:

```js
t("upload.tooLarge", {
  name: file.name,
  size: fmt(file.size)
});
```

The translation can contain placeholders:

```json
"upload.tooLarge": "“{{name}}” is {{size}} — the limit is 10 MB per image."
```

Arabic can use the same placeholders in a different sentence structure.

## Dates, numbers, and currencies

The current page does not contain a user-facing date/currency formatting system that needs localization. File sizes continue to use KB/MB because those are technical units.

If dates, times, percentages, or currencies are added later, use `Intl.DateTimeFormat`, `Intl.NumberFormat`, or a dedicated formatting helper instead of concatenating locale-specific strings.

## Important source-content notes

Two treatment descriptions contain wording that is unclear in the original English source:

- `acrylic technologies*`
- `Russia lips`

They were not silently rewritten as factual medical claims. The Arabic version preserves the ambiguity and flags that these phrases originate from the source wording. They should be reviewed by the site/content owner before publication.

## File structure

```text
index.html
├── locales/
│   ├── en.json        # English translations
│   └── ar.json        # Arabic translations
└── js/
    └── i18n.js        # language loading, switching, persistence, interpolation, RTL
```

## Important maintenance rule

Do not put new user-facing text directly into HTML/JavaScript if it needs translation. Add a meaningful translation key instead.

Prefer:

```js
t("form.success")
```

over:

```js
"Success"
```

And prefer:

```html
<span data-i18n="common.contactUs">Contact us</span>
```

over a hard-coded translated sentence.

Keep keys semantic and reusable. Avoid keys such as `text1`, `button7`, or duplicate keys for the exact same sentence.
