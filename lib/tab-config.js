// Tab visibility defaults — extracted from server.js, data unchanged.
//
// DEFAULT_TAB_SETTINGS is the baseline for admin-controlled tab visibility.
// It's used at boot (to seed TAB_SETTINGS) and by routes/tab-settings.js
// for deep-merging saved overrides on top of defaults.

const DEFAULT_TAB_SETTINGS = {
  overview: true,
  spaced_repetition: true,
  subjects: {
    civil:      { learn: true, quiz: true, mockbar: true, speeddrill: true },
    criminal:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    political:  { learn: true, quiz: true, mockbar: true, speeddrill: true },
    labor:      { learn: true, quiz: true, mockbar: true, speeddrill: true },
    commercial: { learn: true, quiz: true, mockbar: true, speeddrill: true },
    taxation:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    remedial:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    ethics:     { learn: true, quiz: true, mockbar: true, speeddrill: true },
    custom:     { learn: true, quiz: false, mockbar: true, speeddrill: true },
  },
};

module.exports = { DEFAULT_TAB_SETTINGS };
