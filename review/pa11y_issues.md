# pa11y automated findings

Generated from `review/automated/pa11y.json`. Each section corresponds to one reported issue.

---

## 1. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 2.55:1. Recommendation:  change text colour to #00060d.

- Selector: html > body > div:nth-child(2) > header > div:nth-child(2) > div:nth-child(2) > span
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 2.55:1. Recommendation:  change text colour to #00060d.
- Context: 

	<span>⌕</span>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.
- If the element is purely decorative, mark it with `aria-hidden="true"`. Otherwise ensure proper color contrast or replace with accessible SVG.

---

## 2. This select element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #action
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Select.Name
- Type: error
- Message: This select element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<select id="action"><option value="verify" data-i18...</select>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 3. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #action
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<select id="action"><option value="verify" data-i18...</select>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 4. This textarea element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #prompt
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Textarea.Name
- Type: error
- Message: This textarea element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<textarea id="prompt" data-i18n-attr="placeholder:verify.form.promptPlaceholder" placeholder="Doğrulanacak bir iddia veya soru girin…"></textarea>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 5. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #prompt
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<textarea id="prompt" data-i18n-attr="placeholder:verify.form.promptPlaceholder" placeholder="Doğrulanacak bir iddia veya soru girin…"></textarea>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 6. This fileinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #file
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputFile.Name
- Type: error
- Message: This fileinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<input type="file" id="file" accept=".txt,.md,text/plain,text/markdown" hidden="">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 7. This numberinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #obsalertthreshold
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputNumber.Name
- Type: error
- Message: This numberinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<input id="obsalertthreshold" type="number" step="any" value="1" disabled="" data-obs-gated="1">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 8. This textinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #activityactor
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputText.Name
- Type: error
- Message: This textinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<input id="activityactor" data-i18n-attr="placeholder:placeholders.actor" placeholder="ajan veya aktör">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 9. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #activityactor
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<input id="activityactor" data-i18n-attr="placeholder:placeholders.actor" placeholder="ajan veya aktör">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 10. This select element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #activityevent
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Select.Name
- Type: error
- Message: This select element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<select id="activityevent"><option value="" data-i18n="obs...</select>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 11. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #activityevent
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<select id="activityevent"><option value="" data-i18n="obs...</select>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 12. This select element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #emode
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Select.Name
- Type: error
- Message: This select element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<select id="emode"><option value="targetId" data-i...</select>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 13. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #emode
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<select id="emode"><option value="targetId" data-i...</select>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 14. This textinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #einput
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputText.Name
- Type: error
- Message: This textinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<input id="einput" data-i18n-attr="placeholder:evidence.lookup.inputPlaceholder" placeholder="dekont ID veya sourceRef">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 15. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #einput
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<input id="einput" data-i18n-attr="placeholder:evidence.lookup.inputPlaceholder" placeholder="dekont ID veya sourceRef">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 16. This passwordinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #key
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputPassword.Name
- Type: error
- Message: This passwordinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<input type="password" id="key" autocomplete="off" data-i18n-attr="placeholder:settings.workspace.apiKeyPlaceholder" placeholder="HUQAN API anahtarı">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 17. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #key
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<input type="password" id="key" autocomplete="off" data-i18n-attr="placeholder:settings.workspace.apiKeyPlaceholder" placeholder="HUQAN API anahtarı">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 18. This textinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .

- Selector: #workspace
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.InputText.Name
- Type: error
- Message: This textinput element does not have a name available to an accessibility API. Valid names are: label element, title , aria-label , aria-labelledby .
- Context: 

	<input id="workspace" value="default">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 19. This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.

- Selector: #workspace
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.F68
- Type: error
- Message: This form field should be labelled in some way. Use the label element (either with a "for" attribute or wrapped around the form field), or "title", "aria-label" or "aria-labelledby" attributes as appropriate.
- Context: 

	<input id="workspace" value="default">
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 20. This fieldset element does not have a name available to an accessibility API. Valid names are: legend element, aria-label , aria-labelledby .

- Selector: #policy-fields
- Code: WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Fieldset.Name
- Type: error
- Message: This fieldset element does not have a name available to an accessibility API. Valid names are: legend element, aria-label , aria-labelledby .
- Context: 

	<fieldset id="policy-fields" disabled="" style="border:0;padding:0;min-width:0">        <div class="field"><la...</fieldset>
- Runner: htmlcs

**Suggested Fix:**
- Provide an accessible name: add a visible `<label for="...">`, or `aria-label`/`aria-labelledby`. Do not rely on placeholder text.

---

## 21. Fieldset does not contain a legend element. All fieldsets should contain a legend element that describes a description of the field group.

- Selector: #policy-fields
- Code: WCAG2AA.Principle1.Guideline1_3.1_3_1.H71.NoLegend
- Type: error
- Message: Fieldset does not contain a legend element. All fieldsets should contain a legend element that describes a description of the field group.
- Context: 

	<fieldset id="policy-fields" disabled="" style="border:0;padding:0;min-width:0">        <div class="field"><la...</fieldset>
- Runner: htmlcs

**Suggested Fix:**

---

## 22. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(1) > button > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">⌂</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 23. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(2) > button:nth-child(2) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">✓</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 24. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(2) > button:nth-child(3) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">↻</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 25. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(2) > button:nth-child(4) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">⇄</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 26. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(2) > button:nth-child(5) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">▤</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 27. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(3) > button:nth-child(2) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">◉</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 28. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(3) > button:nth-child(3) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">◌</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 29. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(3) > button:nth-child(4) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">⌘</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 30. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(3) > button:nth-child(5) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">△</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 31. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(4) > button:nth-child(2) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">◎</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 32. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(4) > button:nth-child(3) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">☷</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 33. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: html > body > div:nth-child(2) > aside > nav > div:nth-child(4) > button:nth-child(4) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="ico" aria-hidden="true">⚙</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

## 34. This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.

- Selector: #onboardsteps > li:nth-child(1) > i
- Code: WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail
- Type: error
- Message: This element has insufficient contrast at this conformance level. Expected a contrast ratio of at least 4.5:1, but text in this element has a contrast ratio of 3.5:1. Recommendation:  change text colour to #0173ea.
- Context: 

	<i class="onboardmark" aria-hidden="true">○</i>
- Runner: htmlcs

**Suggested Fix:**
- Adjust foreground/background colors to meet WCAG contrast (aim >= 4.5:1). Use semantic tokens and re-run contrast checker.

---

