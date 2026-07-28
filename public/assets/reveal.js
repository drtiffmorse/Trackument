document.addEventListener('DOMContentLoaded', function () {
  var targets = document.querySelectorAll('.reveal');
  if (targets.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    targets.forEach(function (t) { io.observe(t); });
  }

  justifyBrandLines();
  window.addEventListener('resize', justifyBrandLines);
});

// Stretches .subline and .tag to align with the visual stem-to-stem width of
// the wordmark, not its raw bounding box. "TRACKUMENT" starts and ends with
// a T, and a T's top bar overhangs its stem on both sides, so the box edges
// sit ~7px outside where the letterforms actually feel aligned. Measured
// directly from the wordmark glyph: left overhang ~7.4px, right ~7.1px
// at this display size.
var STEM_INSET_LEFT = 7.4;
var STEM_INSET_RIGHT = 7.1;

function measureTextWidth(text, font) {
  var canvas = measureTextWidth._canvas || (measureTextWidth._canvas = document.createElement('canvas'));
  var ctx = canvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

function justifyBrandLines() {
  var wordmark = document.querySelector('.brand-text .wordmark');
  if (!wordmark) return;
  var boxWidth = wordmark.getBoundingClientRect().width;
  var targetWidth = boxWidth - STEM_INSET_LEFT - STEM_INSET_RIGHT;

  document.querySelectorAll('.brand-text .subline, .brand-text .tag').forEach(function (el) {
    // Both lines get the same left offset so they always align with each
    // other, not just independently with the wordmark. The T's stem sits
    // INSET from the bar's outer edge, so this shifts right (positive),
    // not left, to land on the stem rather than the bar's overhang.
    el.style.marginLeft = STEM_INSET_LEFT + 'px';

    var wordSpacingAdjust = 0;
    if (el.classList.contains('tag')) {
      wordSpacingAdjust = -4.5;
      el.style.wordSpacing = wordSpacingAdjust + 'px';
    }
    el.style.letterSpacing = '0px';
    var style = getComputedStyle(el);
    var font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
    var text = el.textContent;
    if (text.length < 2) return;

    // The tag ends in a trailing period ("...DONE."). Fit the width
    // calculation to everything up to and including the E in DONE, and let
    // the period hang past that point, so the E in DISCIPLINE above and the
    // E in DONE below land in the same column instead of the period.
    var fitText = text;
    if (el.classList.contains('tag') && text.slice(-1) === '.') {
      fitText = text.slice(0, -1);
    }

    var spaceCount = (fitText.match(/ /g) || []).length;
    var naturalWidth = measureTextWidth(fitText, font) + (spaceCount * wordSpacingAdjust);
    var extra = targetWidth - naturalWidth;
    var spacing = extra / (fitText.length - 1);
    el.style.letterSpacing = spacing + 'px';
  });
}
