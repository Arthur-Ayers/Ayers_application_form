/* Build a completed, still-editable PDF from the live web form.
 *
 * Neither earlier approach was good enough:
 *
 *   - Filling the original Ayers PDF kept the exact design but was capped by
 *     its fixed rows, so extra people, jobs, properties and assets fell off.
 *   - Screenshotting the page with html2canvas kept everything but produced a
 *     bitmap: soft text, nothing selectable, and a much larger file.
 *
 * So this walks the rendered DOM and redraws it into the PDF as vector — real
 * text, rectangles and lines — with an AcroForm field placed over every input
 * so the result can still be typed into afterwards. Whatever is on screen is
 * what comes out, however many entries have been added.
 */

(function () {
  'use strict';

  var A4_W = 595.276, A4_H = 841.89;
  var MARGIN_X = 31.18;        // 11 mm
  var MARGIN_TOP = 31.18;      // 11 mm
  var MARGIN_BOTTOM = 48;      // room for the page footer below the content
  var FOOTER_Y = 30;           // baseline of the footer's first line

  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* Use one predictable size for the main form and one for the complete
     property table. Writing fixed sizes avoids Preview's oversized 12 pt
     fallback and keeps dropdowns consistent with text inputs. */
  var SINGLE_LINE_FIELD_HEIGHT = 10.5; // PDF points
  var TABLE_FIELD_FONT_SIZE = 7; // PDF points; matches the original Ayers PDF
  var TABLE_FIELD_LINE_HEIGHT = 7.77; // pdf-lib Helvetica multiline leading at 7 pt
  var NORMAL_FIELD_FONT_SIZE = 8; // PDF points
  var PROPERTY_ADDRESS_BLOCK_NUDGE = 0.7; // points downward from exact centre

  function isPropertyAddressName(name) {
    return /^property_\d+_address(?:__\d+)?$/.test(name || '');
  }

  /* pdf-lib top-aligns every multiline field, even when it contains only one
     short line. Property addresses therefore looked higher than the centred
     fields beside them. Keep the field multiline/editable, but centre its
     generated text block vertically inside the widget appearance. */
  function centeredPropertyAddressAppearance(textField, widget, font) {
    var operators = PDFLib.defaultTextFieldAppearanceProvider(textField, widget, font);
    var matrices = operators.filter(function (operator) {
      return String(operator.name) === 'Tm' && operator.args && operator.args.length === 6;
    });
    if (!matrices.length) { return operators; }

    var ys = matrices.map(function (operator) {
      var value = operator.args[5];
      return value.asNumber ? value.asNumber() : parseFloat(String(value));
    });
    var textHeight = font.heightAtSize(TABLE_FIELD_FONT_SIZE);
    var currentMid = (Math.min.apply(Math, ys) + Math.max.apply(Math, ys) + textHeight) / 2;
    var desiredMid = widget.getRectangle().height / 2 - PROPERTY_ADDRESS_BLOCK_NUDGE;
    var delta = desiredMid - currentMid;

    matrices.forEach(function (operator, index) {
      operator.args[5] = PDFLib.PDFNumber.of(ys[index] + delta);
    });
    return operators;
  }

  /* ------------------------------------------------------------------ */
  /* Reading the page                                                    */
  /* ------------------------------------------------------------------ */

  function colour(css) {
    var m = /rgba?\(([^)]+)\)/.exec(css || '');
    if (!m) { return null; }
    var p = m[1].split(',').map(parseFloat);
    if (p.length > 3 && p[3] === 0) { return null; }        // fully transparent
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255 };
  }

  function rgb(c) { return PDFLib.rgb(c.r, c.g, c.b); }

  function isHidden(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 ||
        el.hasAttribute('hidden') ||
        (el.classList && el.classList.contains('no-print') && !el.classList.contains('pdf-show'))) {
      return true;
    }
    // Screen-reader-only text (the income column labels, the table's "Remove")
    // is hidden by clipping it to nothing rather than by display, and would
    // otherwise be drawn on top of the visible headings.
    if (cs.clip && cs.clip !== 'auto' && /rect\(\s*0(px)?[,\s]/.test(cs.clip)) { return true; }
    if (cs.clipPath && /inset\(\s*(50%|100%)/.test(cs.clipPath)) { return true; }
    return false;
  }

  /* Measure text where the browser actually put it.
   *
   * Using the parent element's box instead was wrong twice over: a tick label
   * starts to the right of its checkbox, not at the element's left edge, and a
   * <br> produces two lines that must not be run together. Ranges over the
   * text node give the true rectangle of every rendered line. */
  function textLines(node) {
    var text = node.nodeValue;
    if (!text || !text.trim()) { return []; }

    var range = document.createRange();
    var lines = [];
    var current = null;
    var i = 0;

    while (i < text.length) {
      if (/\s/.test(text[i])) { i++; continue; }
      var start = i;
      while (i < text.length && !/\s/.test(text[i])) { i++; }

      range.setStart(node, start);
      range.setEnd(node, i);
      var r = range.getBoundingClientRect();
      if (!r.width && !r.height) { continue; }

      if (current && Math.abs(r.top - current.top) < 1.5) {
        current.text += ' ' + text.slice(start, i);
        current.right = r.right;
      } else {
        if (current) { lines.push(current); }
        current = { text: text.slice(start, i), left: r.left, top: r.top,
                    bottom: r.bottom, right: r.right, height: r.height };
      }
    }
    if (current) { lines.push(current); }
    return lines;
  }

  function collect(sheet) {
    var box = sheet.getBoundingClientRect();
    var cs0 = getComputedStyle(sheet);
    var padL = parseFloat(cs0.paddingLeft) || 0;
    var padT = parseFloat(cs0.paddingTop) || 0;
    var padR = parseFloat(cs0.paddingRight) || 0;
    var originX = box.left + padL;
    var originY = box.top + padT;

    var items = [];
    $$('*', sheet).forEach(function (el) {
      var cs = getComputedStyle(el);
      if (isHidden(el, cs)) { return; }
      for (var p = el.parentElement; p && p !== sheet.parentElement; p = p.parentElement) {
        if (isHidden(p, getComputedStyle(p))) { return; }
      }

      var r = el.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) { return; }
      if (r.width <= 1.5 && r.height <= 1.5) { return; }   // 1px sr-only boxes
      var base = { x: r.left - originX, y: r.top - originY, w: r.width, h: r.height };
      var tag = el.tagName.toLowerCase();

      if (tag === 'img') { items.push({ kind: 'logo', box: base }); return; }

      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        var fieldType = (el.type || '').toLowerCase();
        var ownBg = colour(cs.backgroundColor);
        var cell = el.closest('table.grid td');
        /* Property-table fields are transparent on screen, showing the white or
           striped cell behind them. Give the PDF field that cell colour rather
           than the grey used for fields elsewhere, which filled the whole table. */
        var fieldBg = ownBg ||
          (cell ? (colour(getComputedStyle(cell).backgroundColor) || { r: 1, g: 1, b: 1 })
                : { r: 0.867, g: 0.871, b: 0.863 });
        if (fieldType !== 'checkbox' && fieldType !== 'radio' && (ownBg || !cell)) {
          items.push({ kind: 'rect', box: base, fill: fieldBg });
        }
        items.push({ kind: 'field', box: base, el: el, tag: tag,
                     type: fieldType,
                     padL: parseFloat(cs.paddingLeft) || 0,
                     bg: fieldBg,
                     ink: colour(cs.color) || { r: 0.25, g: 0.25, b: 0.26 } });
        return;
      }

      var bg = colour(cs.backgroundColor);
      if (tag === 'button') {
        // drawn as the rounded pill it is on screen; its label follows as text
        if (bg) { items.push({ kind: 'pill', box: base, fill: bg, reset: el.id === 'btn-reset' }); }
      } else if (bg) {
        items.push({ kind: 'rect', box: base, fill: bg });
      }

      if (tag !== 'button') ['Top', 'Right', 'Bottom', 'Left'].forEach(function (side) {
        var w = parseFloat(cs['border' + side + 'Width']) || 0;
        var c = colour(cs['border' + side + 'Color']);
        if (w > 0 && c && cs['border' + side + 'Style'] !== 'none') {
          items.push({ kind: 'border', box: base, side: side.toLowerCase(), width: w, fill: c });
        }
      });

      var size = parseFloat(cs.fontSize) || 12;
      var bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
      var ink = colour(cs.color) || { r: 0, g: 0, b: 0 };
      var upper = cs.textTransform === 'uppercase';

      for (var n = 0; n < el.childNodes.length; n++) {
        if (el.childNodes[n].nodeType !== 3) { continue; }
        textLines(el.childNodes[n]).forEach(function (line) {
          items.push({
            kind: 'text',
            box: { x: line.left - originX, y: line.top - originY,
                   w: line.right - line.left, h: line.height },
            text: upper ? line.text.toUpperCase() : line.text,
            size: size, bold: bold, fill: ink
          });
        });
      }
    });

    items.sort(function (a, b) { return (a.box.y - b.box.y) || (a.box.x - b.box.x); });

    function rel(r) { return { top: r.top - originY, bottom: r.bottom - originY }; }
    function visible(el) {
      var r = el.getBoundingClientRect();
      return r.height > 1 && getComputedStyle(el).display !== 'none';
    }

    /* Blocks a page break must not cut through: a label and its field, a row
       of fields, a table row, a group of ticks, a whole employment card. */
    var keeps = [];
    $$(KEEP_TOGETHER.join(','), sheet).forEach(function (el) {
      if (visible(el)) { keeps.push(rel(el.getBoundingClientRect())); }
    });

    /* Headings stay with the start of what they introduce, so no page ends on
       a heading, and a table header never sits alone at the foot of a page. */
    $$(KEEP_WITH_NEXT.join(','), sheet).forEach(function (el) {
      if (!visible(el)) { return; }
      var next = null;
      for (var node = el; node && node !== sheet && !next; node = node.parentElement) {
        for (var sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
          if (visible(sib)) { next = sib; break; }
        }
      }
      if (!next) { return; }
      var a = rel(el.getBoundingClientRect()), b = rel(next.getBoundingClientRect());
      keeps.push({ top: a.top, bottom: Math.max(a.bottom, b.top + Math.min(b.bottom - b.top, 70)) });
    });

    var breaks = $$('[data-pdf-break-before]', sheet).filter(visible).map(function (el) {
      return rel(el.getBoundingClientRect()).top;
    });

    return { items: items, keeps: keeps, breaks: breaks, contentW: box.width - padL - padR };
  }

  var KEEP_TOGETHER = [
    '.field', '.row', '.pair-row', '.exp-line', '.exp-combined', 'tr', '.ticks', '.card',
    '.addr-block', '.scheme-row', '.loan-row', '.q-inline', '.grand-total', '.person-head',
    '.income-cell', '#living-expenses', '[data-asset-group]', '.broker-line', '.masthead'
  ];
  var KEEP_WITH_NEXT = [
    '.bar', '.person-head', '.subhead', '.tick-group-label', 'h1', '.doc-intro', '.decl-confirm',
    'thead', '.question', '.card-title'
  ];

  /* ------------------------------------------------------------------ */
  /* Laying it onto A4                                                   */
  /* ------------------------------------------------------------------ */

  /* Choose where each page ends. A page is cut at the lowest point that
     still fits and that
       - does not pass through any item (a field, a table row, a line of text),
       - does not pass through a keep-together block or a heading and the start
         of what follows it,
     unless a section asks to start on a new page. A block taller than a whole
     page cannot be kept together and is allowed to break. */
  function paginate(read, pageH) {
    var items = read.items;
    if (!items.length) { return []; }
    var tall = pageH * 0.9;
    var solid = items.filter(function (it) { return it.box.h < tall; }).map(function (it) {
      return { top: it.box.y, bottom: it.box.y + it.box.h };
    });
    var keeps = read.keeps.filter(function (k) { return k.bottom - k.top < tall; });
    var tops = items.map(function (it) { return it.box.y; })
      .concat(read.keeps.map(function (k) { return k.top; }))
      .sort(function (x, y) { return x - y; });
    var end = Math.max.apply(null, items.map(function (it) { return it.box.y + it.box.h; }));

    function clear(y) {
      function through(r) { return r.top < y - 0.5 && r.bottom > y + 0.5; }
      return !solid.some(through) && !keeps.some(through);
    }

    var pages = [], top = Math.min.apply(null, items.map(function (it) { return it.box.y; }));
    for (var guard = 0; guard < 200; guard++) {
      var limit = top + pageH;
      var forced = read.breaks.filter(function (y) { return y > top + 1 && y <= limit; })
        .sort(function (x, y) { return x - y; })[0];
      var cut;
      if (forced !== undefined) {
        cut = forced;
      } else if (end <= limit) {
        cut = Infinity;
      } else {
        cut = null;
        for (var i = tops.length - 1; i >= 0; i--) {
          var y = tops[i];
          if (y <= top + 1) { break; }
          if (y <= limit && clear(y)) { cut = y; break; }
        }
        if (cut === null) {   // nothing clean fits: cut at the last item start that fits
          cut = tops.filter(function (t) { return t > top + 1 && t <= limit; }).pop() ||
                tops.filter(function (t) { return t > top + 1; })[0];
        }
      }
      var pageItems = items.filter(function (it) {
        return it.box.y >= top - 0.5 && it.box.y < cut - 0.5;
      });
      if (pageItems.length) { pages.push({ top: top, items: pageItems }); }
      if (cut === Infinity || cut === undefined) { break; }
      top = cut;
    }
    return pages;
  }

  function wrap(text, font, size, maxWidth) {
    if (!text) { return ['']; }
    if (font.widthOfTextAtSize(text, size) <= maxWidth) { return [text]; }
    var words = text.split(' '), lines = [], line = '';

    /* A reference number, unit identifier or email-like address may contain
       no spaces. Split such tokens by character so they cannot disappear
       beyond the right edge of the editable PDF field. */
    function pieces(word) {
      if (font.widthOfTextAtSize(word, size) <= maxWidth) { return [word]; }
      var result = [], part = '';
      Array.from(word).forEach(function (character) {
        var trial = part + character;
        if (part && font.widthOfTextAtSize(trial, size) > maxWidth) {
          result.push(part);
          part = character;
        } else {
          part = trial;
        }
      });
      if (part) { result.push(part); }
      return result;
    }

    words.forEach(function (word) {
      pieces(word).forEach(function (piece) {
        var trial = line ? line + ' ' + piece : piece;
        if (!line || font.widthOfTextAtSize(trial, size) <= maxWidth) {
          line = trial;
        } else {
          lines.push(line);
          line = piece;
        }
      });
    });
    if (line) { lines.push(line); }
    return lines;
  }

  /* Browser textareas and PDF Helvetica do not always wrap at exactly the
     same character. Size each address from the PDF's real font metrics before
     collecting the page layout, then make every control in that row equally
     tall. This guarantees that every generated PDF line fits and that all
     horizontal input rules share the same top and bottom positions. */
  function fitPropertyRowsForPdf(font, usableWidth) {
    $$('#property-table [data-property-row]').forEach(function (row) {
      var address = row.querySelector('textarea');
      if (!address) { return; }

      var sheet = address.closest('.sheet');
      var sheetBox = sheet.getBoundingClientRect();
      var sheetStyle = getComputedStyle(sheet);
      var contentWidth = sheetBox.width - (parseFloat(sheetStyle.paddingLeft) || 0) -
        (parseFloat(sheetStyle.paddingRight) || 0);
      var scale = usableWidth / contentWidth;
      var addressStyle = getComputedStyle(address);
      var inset = (parseFloat(addressStyle.paddingLeft) || 0) * scale;
      var pdfWidth = Math.max(20, address.getBoundingClientRect().width * scale - inset - 6);
      var value = safeText(address.value || '').replace(/\s+/g, ' ').trim();
      var lineCount = value ? wrap(value, font, TABLE_FIELD_FONT_SIZE, pdfWidth).length : 1;
      var textHeight = font.heightAtSize(TABLE_FIELD_FONT_SIZE);

      /* 3 pt is removed by addField's vertical inset; another 3 pt gives the
         first and last glyphs safe clearance in Preview and Acrobat. */
      var requiredPdfHeight = textHeight + (lineCount - 1) * TABLE_FIELD_LINE_HEIGHT + 6;
      /* Never shrink below the browser's own complete content height either;
         the larger of the browser and PDF calculations is the safe answer. */
      var requiredCssHeight = Math.max(50, address.scrollHeight,
        Math.ceil(requiredPdfHeight / scale));

      address.style.height = requiredCssHeight + 'px';
      $$('input[type="text"], select, .tick', row).forEach(function (control) {
        control.style.height = requiredCssHeight + 'px';
      });
    });
    void document.body.offsetHeight;
  }

  /* The standard PDF fonts are WinAnsi, so swap the typographic characters
     the form uses rather than letting a draw call throw. */
  function safeText(s) {
    return String(s)
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-').replace(/…/g, '...')
      .replace(/ /g, ' ').replace(/×/g, 'x')
      .replace(/[^\x20-\x7E\xA1-\xFF]/g, '');
  }

  /* ------------------------------------------------------------------ */
  /* Drawing                                                             */
  /* ------------------------------------------------------------------ */

  function makeDrawer(ctx, page, pageTop) {
    var s = ctx.scale;
    function X(px) { return MARGIN_X + px * s; }
    function Y(py) { return ctx.pageTopPt - (py - pageTop) * s; }

    return {
      rect: function (b, fill) {
        page.drawRectangle({ x: X(b.x), y: Y(b.y + b.h),
          width: b.w * s, height: b.h * s, color: rgb(fill) });
      },
      border: function (b, side, width, fill) {
        var t = Math.max(0.3, width * s);
        var g = {
          top:    { x: b.x, y: b.y, w: b.w, h: width },
          bottom: { x: b.x, y: b.y + b.h - width, w: b.w, h: width },
          left:   { x: b.x, y: b.y, w: width, h: b.h },
          right:  { x: b.x + b.w - width, y: b.y, w: width, h: b.h }
        }[side];
        page.drawRectangle({ x: X(g.x), y: Y(g.y + g.h),
          width: Math.max(t, g.w * s), height: Math.max(t, g.h * s), color: rgb(fill) });
      },
      text: function (it) {
        var value = safeText(it.text);
        if (!value) { return; }
        var font = it.bold ? ctx.bold : ctx.font;
        var size = it.size * s;
        // the line rect is the inline box; sit the baseline inside it
        var baseline = it.box.y + (it.box.h + it.size * 0.72) / 2;
        page.drawText(value, {
          x: X(it.box.x), y: Y(baseline), size: size, font: font, color: rgb(it.fill)
        });
      },
      pill: function (b, fill) {
        var w = b.w * s, h = b.h * s, r = h / 2;
        var d = 'M ' + r + ' 0 H ' + (w - r) + ' A ' + r + ' ' + r + ' 0 0 1 ' + (w - r) + ' ' + h +
                ' H ' + r + ' A ' + r + ' ' + r + ' 0 0 1 ' + r + ' 0 Z';
        page.drawSvgPath(d, { x: X(b.x), y: Y(b.y), color: rgb(fill) });
      },
      pos: function (b) {
        return { x: X(b.x), y: Y(b.y + b.h), width: b.w * s, height: b.h * s };
      }
    };
  }

  function uniqueName(used, name) {
    var base = name || 'field', n = base, i = 2;
    while (used[n]) { n = base + '__' + (i++); }
    used[n] = true;
    return n;
  }

  function addField(ctx, page, it, place) {
    var name = uniqueName(ctx.used, it.el.name || it.el.id);
    var grey = it.bg, ink = it.ink;

    if (it.type === 'checkbox' || it.type === 'radio') {
      var cb = ctx.form.createCheckBox(name);
      cb.addToPage(page, {
        x: place.x, y: place.y, width: place.width, height: place.height,
        borderWidth: 0.6, borderColor: PDFLib.rgb(0.43, 0.43, 0.44),
        backgroundColor: PDFLib.rgb(1, 1, 1)
      });
      /* Tick it only after the widget exists. A checkbox carries its state
         twice — the field's value, and the widget's appearance state, which is
         what a viewer actually draws. Ticking first sets the value, then
         addToPage creates the widget with its appearance state at "off", and
         every ticked box exports as an empty square. */
      if (it.el.checked) { cb.check(); }
      return;
    }

    // keep the input's own left padding clear — that is where the $ sits
    var inset = it.padL * ctx.scale;
    var x = place.x + inset;
    var width = Math.max(6, place.width - inset - 1);
    var multiline = it.tag === 'textarea';
    var inPropertyTable = it.el.closest && it.el.closest('#property-table');
    var fieldY = place.y;
    var fieldHeight = place.height;
    if (multiline || inPropertyTable) {
      var verticalInset = Math.min(1.5, place.height * 0.08);
      fieldY += verticalInset;
      fieldHeight = Math.max(6, place.height - verticalInset * 2);
    } else {
      fieldHeight = Math.min(place.height, SINGLE_LINE_FIELD_HEIGHT);
      fieldY += (place.height - fieldHeight) / 2;
    }

    var field;
    if (it.tag === 'select') {
      field = ctx.form.createDropdown(name);
      var opts = Array.prototype.map.call(it.el.options, function (o) { return safeText(o.value); })
        .filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      if (opts.length) { field.addOptions(opts); }
      if (it.el.value) {
        try { field.select(safeText(it.el.value)); } catch (e) { /* not an option */ }
      }
    } else {
      field = ctx.form.createTextField(name);
      if (multiline) { field.enableMultiline(); }
      var value = safeText(isExpenseAmount(it.el) ? moneyText(it.el.value) : (it.el.value || ''));
      /* Normalize the address and insert compact line breaks using the
         requested address font size. */
      if (isPropertyAddressName(name)) {
        value = value.replace(/\s+/g, ' ').trim();
        value = wrap(value, ctx.font, TABLE_FIELD_FONT_SIZE,
          Math.max(20, width - 5)).join('\n');
      }
      field.setText(value);
    }

    field.addToPage(page, {
      x: x, y: fieldY, width: width, height: fieldHeight,
      borderWidth: 0, backgroundColor: rgb(grey), textColor: rgb(ink), font: ctx.font
    });
    var fixedSize = inPropertyTable ? TABLE_FIELD_FONT_SIZE : NORMAL_FIELD_FONT_SIZE;
    /* A single-line value too wide for its box is shrunk to fit rather than cut
       off — "1,200,000" in a narrow table column otherwise printed as "1,200,00". */
    /* Dropdowns need more room: Chrome draws a 13pt arrow button inside the
       field, which hid "Applicant 1" in a narrow Owner column. */
    if (!multiline && it.type !== 'checkbox') {
      var shown = safeText(it.el.value || '');
      if (isExpenseAmount(it.el)) { shown = moneyText(it.el.value); }
      var room = width - (it.tag === 'select' ? 20 : 9);   // arrow + padding + a little slack; Preview pads ~4pt a side
      while (shown && fixedSize > 5 && ctx.font.widthOfTextAtSize(shown, fixedSize) > room) {
        fixedSize -= 0.25;
      }
    }
    ctx.fieldFontSizes[name] = fixedSize;
    field.setFontSize(fixedSize);
    if (it.el.readOnly && field.enableReadOnly) { field.enableReadOnly(); }
  }

  /* Living expense totals recalculate inside the downloaded PDF.

     The web form fills the totals in before export, so they are right when the
     file is saved. These scripts keep them right afterwards: change a figure in
     the PDF and the column totals and the overall total follow. Viewers that
     run form scripts (Adobe Acrobat and Reader, Chrome, Firefox) do this; macOS
     Preview runs no scripts at all, so there the totals stay as downloaded.

     Every amount in the section is stored and shown as dollars and cents with
     separators — "2,000.00". The cents are not decoration. A bare "2,000" is
     read by some viewers as the number 2, the comma taken for a decimal point
     (Firefox does; it made every total wrong), and Preview displays the stored
     text as-is, so storing a plain "2000" instead would lose the separators
     there. "2,000.00" reads correctly everywhere. Typed entries such as
     "$2500" are normalised to the same form when the field is left. */
  var MONEY_JS = [
    'function money(v) {',
    '  var t = parseFloat(String(v).replace(/[^0-9.\\-]/g, ""));',
    '  if (isNaN(t) || t === 0) { return ""; }',
    '  var parts = Math.abs(Math.round(t * 100) / 100).toFixed(2).split(".");',
    '  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");',
    '  return (t < 0 ? "-" : "") + parts.join(".");',
    '}'
  ].join('\n');

  // the same formatting, for the values written into the file
  function moneyText(v) {
    var t = parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
    if (isNaN(t) || t === 0) { return ''; }
    var parts = Math.abs(Math.round(t * 100) / 100).toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (t < 0 ? '-' : '') + parts.join('.');
  }

  function isExpenseAmount(el) {
    return !!(el.closest && (el.closest('#living-expenses .exp-cell') ||
      el.getAttribute('data-total') === 'combined'));
  }

  function keystrokeScript() {
    return MONEY_JS + '\nif (event.willCommit) { event.value = money(event.value); }';
  }

  function formatScript() {
    return MONEY_JS + '\nevent.value = money(event.value);';
  }

  function sumScript(names) {
    return [
      MONEY_JS,
      'var names = ' + JSON.stringify(names) + ';',
      'var t = 0;',
      'for (var i = 0; i < names.length; i++) {',
      '  var f = this.getField(names[i]);',
      '  if (!f) { continue; }',
      '  var n = parseFloat(String(f.value).replace(/[^0-9.\\-]/g, ""));',
      '  if (!isNaN(n)) { t += n; }',
      '}',
      'event.value = money(t);'
    ].join('\n');
  }

  function addExpenseCalculations(pdf, ctx) {
    var form = ctx.form;
    var grid = document.getElementById('living-expenses');
    if (!grid) { return; }
    function field(name) {
      try { return name ? form.getTextField(name) : null; } catch (e) { return null; }
    }
    function js(code) {
      return pdf.context.obj({ S: 'JavaScript', JS: PDFLib.PDFHexString.fromText(code) });
    }

    // Every amount and total in the section: stored plain, shown formatted.
    var actions = {};   // field name -> { K, F, C }
    var amountInputs = $$('.exp-cell input', grid).concat($$('[data-total="combined"]'));
    amountInputs.forEach(function (el) {
      var f = field(el.name);
      if (!f) { return; }
      actions[el.name] = { K: js(keystrokeScript()), F: js(formatScript()) };
    });

    var order = [];
    function attach(targetName, names) {
      var target = field(targetName);
      names = names.filter(function (n) { return field(n); });
      if (!target || !names.length || !actions[targetName]) { return; }
      actions[targetName].C = js(sumScript(names));
      order.push(target.ref);
    }
    function totalName(which, n) {
      var el = grid.querySelector('.exp-line[data-exp-total="' + which + '"] ' +
        '.exp-cell[data-exp-person="' + n + '"] input');
      return el ? el.name : null;
    }

    /* One amount column per applicant. /CO fixes the order: each column's
       General and Additional totals first, then each column's Total Living
       Expenses and the overall total — anything earlier would be one edit
       behind. The overall total adds the column totals directly, because with
       a single column the per-applicant total line is not shown or exported. */
    var cols = parseInt(grid.getAttribute('data-cols') || '1', 10);
    var people = [];
    for (var c = 1; c <= cols; c++) { people.push(String(c)); }
    people.forEach(function (n) {
      ['general', 'additional'].forEach(function (g) {
        attach(totalName(g, n), $$('.exp-cell[data-exp-person="' + n + '"] [data-sum="' + g + '"]', grid)
          .map(function (el) { return el.name; }));
      });
    });
    people.forEach(function (n) {
      attach(totalName('grand', n), [totalName('general', n), totalName('additional', n)]);
    });
    var combined = document.querySelector('[data-total="combined"]');
    if (combined) {
      var parts = [];
      people.forEach(function (n) { parts.push(totalName('general', n), totalName('additional', n)); });
      attach(combined.name, parts);
    }

    Object.keys(actions).forEach(function (name) {
      field(name).acroField.dict.set(PDFLib.PDFName.of('AA'), pdf.context.obj(actions[name]));
    });
    if (order.length) {
      form.acroForm.dict.set(PDFLib.PDFName.of('CO'), pdf.context.obj(order));
    }
  }

  /* The same footer on every page, as on the printed form: "Confidential",
     the form name and version, and "Page n of N". The wording comes from the
     on-screen footer so the two cannot drift apart. */
  function drawFooters(pdf, ctx) {
    var spans = $$('.sheet-footer > span');
    var left = spans[0] ? spans[0].textContent.trim() : 'Confidential';
    var mid = spans[1] ? spans[1].innerText.split('\n').map(function (t) { return t.trim(); }).filter(Boolean)
                       : ['AYERS Loan Application'];
    var grey = PDFLib.rgb(0.6, 0.6, 0.61), size = 6.5, font = ctx.font;
    var pages = pdf.getPages(), total = pages.length;
    pages.forEach(function (page, i) {
      page.drawText(safeText(left), { x: MARGIN_X, y: FOOTER_Y, size: size, font: font, color: grey });
      mid.forEach(function (line, n) {
        var text = safeText(line), w = font.widthOfTextAtSize(text, size);
        page.drawText(text, { x: (A4_W - w) / 2, y: FOOTER_Y - n * 9, size: size, font: font, color: grey });
      });
      var right = 'Page ' + (i + 1) + ' of ' + total, rw = font.widthOfTextAtSize(right, size);
      page.drawText(right, { x: A4_W - MARGIN_X - rw, y: FOOTER_Y, size: size, font: font, color: grey });
    });
  }

  /* RESET works in the PDF as it did on the paper form, in viewers that run
     form scripts. It asks first: one stray click would otherwise wipe a
     completed application. Added after the field appearances are generated,
     so the pill drawn on the page is not painted over with a grey box. */
  function addResetButton(pdf, ctx) {
    if (!ctx.resetButton) { return; }
    var p = ctx.resetButton.place;
    var dict = pdf.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Btn', Ff: 65536, F: 4,
      T: PDFLib.PDFHexString.fromText('reset_form'),
      TU: PDFLib.PDFHexString.fromText('Clear every field in this form'),
      Rect: [p.x, p.y, p.x + p.width, p.y + p.height],
      P: ctx.resetButton.page.ref,
      A: {
        S: 'JavaScript',
        JS: PDFLib.PDFHexString.fromText(
          'if (app.alert("Clear every field in this application?", 2, 2) == 4) { this.resetForm(); }')
      }
    });
    var ref = pdf.context.register(dict);
    ctx.resetButton.page.node.addAnnot(ref);
    ctx.form.acroForm.addField(ref);
  }

  /* Masthead logo, drawn from its own SVG paths so it stays vector. */
  var LOGO_VIEW = { x: 33.5, y: 58.5, w: 126.5, h: 76 };
  var logoCache = null;

  async function logoPaths() {
    if (logoCache) { return logoCache; }
    var svg = await (await fetch('assets/ayers-logo.svg')).text();
    var out = [], re = /<path[^>]*?fill="([^"]*)"[^>]*?d="([^"]*)"/g, m;
    while ((m = re.exec(svg))) { out.push({ fill: m[1], d: m[2] }); }
    logoCache = out;
    return out;
  }

  function drawLogo(page, place, paths) {
    if (!paths.length) { return; }
    var scale = place.width / LOGO_VIEW.w;
    paths.forEach(function (p) {
      var c = /^#[0-9a-f]{6}$/i.test(p.fill)
        ? { r: parseInt(p.fill.slice(1, 3), 16) / 255,
            g: parseInt(p.fill.slice(3, 5), 16) / 255,
            b: parseInt(p.fill.slice(5, 7), 16) / 255 }
        : { r: 0.1, g: 0.1, b: 0.1 };
      page.drawSvgPath(p.d, {
        x: place.x - LOGO_VIEW.x * scale,
        y: place.y + place.height + LOGO_VIEW.y * scale,
        scale: scale, color: rgb(c)
      });
    });
  }

  /* ------------------------------------------------------------------ */

  async function buildPdf() {
    if (!window.PDFLib) { throw new Error('The PDF library did not load. Refresh and try again.'); }
    if (document.fonts && document.fonts.ready) { await document.fonts.ready; }

    var pdf = await PDFLib.PDFDocument.create();
    var ctx = {
      form: pdf.getForm(),
      font: await pdf.embedFont(PDFLib.StandardFonts.Helvetica),
      bold: await pdf.embedFont(PDFLib.StandardFonts.HelveticaBold),
      used: Object.create(null),
      fieldFontSizes: Object.create(null),
      pageTopPt: A4_H - MARGIN_TOP
    };
    pdf.setTitle(document.title || 'Ayers Loan Application');
    pdf.setAuthor('Ayers Financial Group');

    var paths = [];
    try { paths = await logoPaths(); } catch (e) { paths = []; }

    var usableW = A4_W - MARGIN_X * 2;
    var usableH = A4_H - MARGIN_TOP - MARGIN_BOTTOM;
    var pageCount = 0;

    /* Measure the web form exactly as it is on screen and scale it to the
       page width. One uniform scale keeps every font size and every gap in
       the same proportion as the browser shows them; the document simply runs
       to as many pages as the content needs.

       The only thing changed for the measurement is that the on-screen-only
       controls are taken out of the flow. Merely skipping them at draw time
       left their space behind as unexplained gaps — most visibly above the
       income details, where the "+ Add job" button sits. */
    var hide = document.createElement('style');
    hide.textContent =
      '.no-print:not(.pdf-show) { display: none !important; }' +
      '.pdf-only { display: block !important; }' +
      // the footer is drawn on every page instead, with page numbers
      '.sheet-footer { display: none !important; }' +
      // a section that starts a new page needs no rule or gap above it
      '[data-pdf-break-before] { margin-top: 0 !important; padding-top: 0 !important; border-top: 0 !important; }';
    document.head.appendChild(hide);
    void document.body.offsetHeight;
    var sheetData;
    try {
      fitPropertyRowsForPdf(ctx.font, usableW);
      sheetData = $$('.sheet').map(function (sheet) { return collect(sheet); });
    } finally {
      hide.remove();
      void document.body.offsetHeight;
    }

    for (var s = 0; s < sheetData.length; s++) {
      var read = sheetData[s];
      ctx.scale = usableW / read.contentW;

      paginate(read, usableH / ctx.scale).forEach(function (slice) {
        var page = pdf.addPage([A4_W, A4_H]);
        pageCount++;
        var draw = makeDrawer(ctx, page, slice.top);

        // backgrounds and rules first, then everything that sits on them
        slice.items.forEach(function (it) {
          if (it.kind === 'pill') {
            draw.pill(it.box, it.fill);
            if (it.reset) { ctx.resetButton = { page: page, place: draw.pos(it.box) }; }
          }
          if (it.kind === 'rect') { draw.rect(it.box, it.fill); }
          else if (it.kind === 'border') { draw.border(it.box, it.side, it.width, it.fill); }
        });
        slice.items.forEach(function (it) {
          if (it.kind === 'logo') { drawLogo(page, draw.pos(it.box), paths); }
          else if (it.kind === 'text') { draw.text(it); }
          else if (it.kind === 'field') { addField(ctx, page, it, draw.pos(it.box)); }
        });
      });
    }

    ctx.form.updateFieldAppearances(ctx.font);
    /* Keep each editable field's /DA identical to the size used in its /AP.
       Preview otherwise rewrites fields to a different size after interaction. */
    ctx.form.getFields().forEach(function (field) {
      if (field instanceof PDFLib.PDFTextField || field instanceof PDFLib.PDFDropdown ||
          field instanceof PDFLib.PDFOptionList) {
        if (field instanceof PDFLib.PDFTextField && isPropertyAddressName(field.getName())) {
          field.updateAppearances(ctx.font, centeredPropertyAddressAppearance);
        }
        var fixedSize = ctx.fieldFontSizes[field.getName()] || 0;
        field.setFontSize(fixedSize);
        /* pdf-lib keeps /DA on the parent field, but macOS Preview reads the
           widget's own /DA when it rewrites a form. Without this copy Preview
           discards the requested size and falls back to Helvetica 12. The
           original Ayers PDF stores /DA on both objects. */
        var appearance = field.acroField.getDefaultAppearance();
        field.acroField.getWidgets().forEach(function (widget) {
          widget.setDefaultAppearance(appearance);
        });
      }
    });
    drawFooters(pdf, ctx);
    addResetButton(pdf, ctx);
    addExpenseCalculations(pdf, ctx);
    return {
      bytes: await pdf.save({ updateFieldAppearances: false }),
      pages: pageCount,
      fields: ctx.form.getFields().length
    };
  }

  window.AyersPdf = {
    lastResult: null,
    download: async function (filename) {
      var built = await buildPdf();
      var blob = new Blob([built.bytes], { type: 'application/pdf' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 2000);
      window.AyersPdf.lastResult = { pages: built.pages, fields: built.fields, bytes: built.bytes.length };
      return [];   // nothing is capped any more, so nothing to report as dropped
    }
  };
})();
