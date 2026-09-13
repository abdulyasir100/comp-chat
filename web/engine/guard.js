/* Narration guard. Ported from town.exe prompts.py (reads_as_narration,
   narration_retry_messages).

   A line that should be SPEECH sometimes comes back as the model describing the
   character from outside — "She teases him and laughs it off" instead of
   "Ha! You wish, buddy." Deliberately narrow: a false positive costs a retry on
   a good line, and if the retry also trips the turn is dropped, so over-eager
   detection would be a worse bug than the one it fixes. */
(function (global) {
  'use strict';

  var FIRST_PERSON = /\b(i|i'm|i'll|i've|i'd|me|my|mine|myself|we|we're|us|our)\b/i;
  var NARRATION_OPENER = /^\W*(she|he|they)\b['’]?/i;
  var THIRD_PERSON_OBJECT = /\b(him|her|hers|his|them|their|theirs)\b/i;

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  var Guard = {
    /* Two signatures, both requiring NO first-person pronoun anywhere:
       1. opens with a third-person subject AND refers to the other party in the
          third person too ("She's not coming, is she?" is speech ABOUT someone
          absent — it lacks the second half);
       2. opens with the speaker's own name plus a verb ("Aria laughs it off").
          "Aria! Over here." is address, hence the punctuation guard. */
    readsAsNarration: function (line, speakerName) {
      var s = String(line || '').trim();
      if (!s || FIRST_PERSON.test(s)) return false;
      if (NARRATION_OPENER.test(s) && THIRD_PERSON_OBJECT.test(s)) return true;
      var first = String(speakerName || '').trim().split(/\s+/)[0];
      if (first) {
        var re = new RegExp('^\\W*' + escapeRe(first) + '\\b(?!\\s*[,:!?])', 'i');
        return re.test(s);
      }
      return false;
    },

    /* Re-ask for the same JSON after a slip, showing the model its own bad answer.
       One retry, not a loop: if the correction doesn't take, the caller must drop
       the turn rather than store narration — stored narration comes back as
       history and teaches the character to keep doing it. */
    retryMessages: function (messages, badLine) {
      return (messages || []).concat([
        { role: 'assistant', content: String(badLine || '') },
        { role: 'user', content:
          'That was a DESCRIPTION of you in the third person, not speech. Reply again with the ' +
          'exact words you say out loud, first person, in character — same JSON shape.' }
      ]);
    }
  };

  global.Guard = Guard;
})(typeof window !== 'undefined' ? window : globalThis);
