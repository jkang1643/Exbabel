Chirp 3: HD SSML support
Preview

This product or feature is subject to the "Pre-GA Offerings Terms" in the General Service Terms section of the Service Specific Terms. Pre-GA products and features are available "as is" and might have limited support. For more information, see the launch stage descriptions.

Speech Synthesis Markup Language (SSML) tags give you more control over how text is converted into speech. By using SSML, you can specify pronunciations, paragraphs, control and influence the overall structure of the input text for more natural-sounding audio.

Supported SSML elements
Chirp 3: HD voices support a subset of the available SSML tags, which are described here. Any tags that are not on this list will be ignored during the synthesis process.

<speak>: The root element of the SSML text.
<say-as>: Lets you provide hints about how to pronounce the contained text. Note that interpret-as="expletive" or interpret-as="bleep" are not supported.
<p>: Represents a paragraph.
<s>: Represents a sentence.
<phoneme>: Provides a phonetic pronunciation for the contained text.
<sub>: Pronounces the alias value instead of the element's contained text.
Sample SynthesizeSpeechRequest using SSML:



{
  "audio_config": {
    "audio_encoding": "LINEAR16",
  },
  "input": {
    "ssml": "<speak>Here are <say-as interpret-as=\"characters\">SSML</say-as> samples. I can also substitute phrases, like the <sub alias=\"World Wide Web Consortium\">W3C</sub>. Hi,<phoneme alphabet=\"ipa\" ph=\"ˌmænɪˈtoʊbə\">manitoba<phoneme>! Finally, I can speak a paragraph with two sentences. <p><s>This is sentence one.</s><s>This is sentence two.</s></p></speak>",
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
}
Chirp 3: HD voice controls
Preview

This product or feature is subject to the "Pre-GA Offerings Terms" in the General Service Terms section of the Service Specific Terms. Pre-GA products and features are available "as is" and might have limited support. For more information, see the launch stage descriptions.

Voice control features are specifically for HD voice synthesis. You can manage pace control, pause control, and custom pronunciations through the Chirp 3: HD voice control options.

Pace control
You can adjust the speed of the generated audio using the pace parameter. The pace parameter lets you slow down or speed up the speech, with values ranging from 0.25x (very slow) to 2x (very fast). To set the pace, use the speaking_rate parameter in your request. Choose a value between 0.25 and 2.0. Values below 1.0 slow down the speech, and values above 1.0 speed it up. A value of 1.0 indicates an unadjusted pace.

Sample SynthesizeSpeechRequest using pace control:



{
  "audio_config": {
    "audio_encoding": "LINEAR16",
    "speaking_rate": 2.0,
  },
  "input": {
    "text": "Once upon a time, there was a cute cat. He was so cute that he got lots of treats.",
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
}
Sample StreamingSynthesizeConfig using pace control:



{
  "streaming_audio_config": {
    "audio_encoding": "LINEAR16",
    "speaking_rate": 2.0,
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
}
Pace control audio samples:

Speaking rate	Output
0.5	
1.0	
2.0	
Pause control
You can insert pauses into AI-generated speech by embedding special tags directly into your text using the markup input field. Note that pause tags will only work in the markup field, and not in the text field.

These tags signal the AI to create silences, but the precise length of these pauses isn't fixed. The AI adjusts the duration based on context, much like natural human speech varies with speaker, location, and sentence structure. The available pause tags are [pause short], [pause long], and [pause]. For alternative methods of creating pauses without using markup tags, refer to our prompting and crafting guidelines.

The AI model might occasionally disregard the pause tags, especially if they are placed in unnatural positions in the text. You can combine multiple pause tags for longer silences, but excessive use can lead to problems.

Sample SynthesizeSpeechRequest using pause control:



{
  "audio_config": {
    "audio_encoding": "LINEAR16",
  },
  "input": {
    "markup": "Let me take a look, [pause long] yes, I see it.",
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
}
Sample StreamingSynthesisInput using pause control:



{
  "markup": "Let me take a look, [pause long] yes, I see it.",
}
Pause control audio samples:

Markup input	Output
"Let me take a look, yes, I see it."	
"Let me take a look, [pause long] yes, I see it."	
Custom pronunciations
You can specify custom pronunciations using IPA or X-SAMPA phonetic representations for words within the input text. Be sure to use language-appropriate phonemes for accurate rendering. You can learn more about phoneme override in our phoneme documentation.

Sample SynthesizeSpeechRequest using custom pronunciations:



{
  "audio_config": {
    "audio_encoding": "LINEAR16",
  },
  "input": {
    "text": "There is a dog in the boat",
    "custom_pronunciations": {
      "phrase": "dog",
      "phonetic_encoding": "PHONETIC_ENCODING_X_SAMPA",
      "pronunciation": "\"k{t",
    }
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
}
Sample StreamingSynthesizeConfig using custom pronunciations:



{
  "streaming_audio_config": {
    "audio_encoding": "LINEAR16",
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
  "custom_pronunciations": {
    "phrase": "dog",
    "phonetic_encoding": "PHONETIC_ENCODING_X_SAMPA",
    "pronunciation": "\"k{t",
  }
}
Custom pronunciations audio samples:

Custom pronunciations applied	Output
None	
"dog" pronounced as ""k{t"	
The overridden phrases can be formatted in any way, including using symbols. For example, in case of potential context-based ambiguity in phrase matching (which is common in languages like Chinese and Japanese) or sentences where one word might be pronounced in different ways, the phrase can be formatted to remove ambiguity. For example, to avoid accidentally overriding other instances of the word read in the input, the phrase "read" could be formatted as "read1", "[read]", or "(read)" for both the input text and the overridden phrase.

See this example of applying custom pronunciations to a sentence where the word read is pronounced in two different ways:



{
  "audio_config": {
    "audio_encoding": "LINEAR16",
  },
  "input": {
    "text": "I read1 a book, and I will now read2 it to you.",
    "custom_pronunciations": {
      "phrase": "read1",
      "phonetic_encoding": "PHONETIC_ENCODING_IPA",
      "pronunciation": "rɛd",
    }
    "custom_pronunciations": {
      "phrase": "read2",
      "phonetic_encoding": "PHONETIC_ENCODING_IPA",
      "pronunciation": "riːd",
    }
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
}
Custom pronunciations applied	Output
"read" overridden two ways	
Furthermore, custom pronunciations may be used with markup input, which enables the usage of pause tags as well:



{
  "audio_config": {
    "audio_encoding": "LINEAR16",
  },
  "input": {
    "markup": "Did you [pause long] read this book?",
    "custom_pronunciations": {
      "phrase": "read",
      "phonetic_encoding": "PHONETIC_ENCODING_IPA",
      "pronunciation": "riːd",
    }
  },
  "voice": {
    "language_code": "en-US",
    "name": "en-us-Chirp3-HD-Leda",
  }
}
Custom pronunciations used	Output
Override pronunciation with pause tag	
Language availability for voice controls
Pace control is available across all locales.

Pause control is available across all locales except: bg-bg, cs-cz, el-gr, et-ee, he-il, hr-hr, hu-hu, lt-lt, lv-lv, pa-in, ro-ro, sk-sk, sl-si, sr-rs, and yue-hk.

Custom pronunciations is available across all locales except: bg-bg, bn-in, cs-cz, da-dk, el-gr, et-ee, fi-fi, gu-in, he-il, hr-hr, hu-hu, lt-lt, lv-lv, nb-no, nl-be, pa-in, ro-ro, sk-sk, sl-si, sr-rs, sv-se, sw-ke, th-th, uk-ua, ur-in, vi-vn, and yue-hk.

FAQ
Common questions and their answers:

How do I control pacing and flow to improve the speech output?
You can utilize our prompting and crafting guidelines and improve your text prompt to improve your speech output.

How do I access voices in supported languages?
Voice names follow a specific format, allowing usage across supported languages by specifying the voice uniquely. The format follows \<locale\>-\<model\>-\<voice\>. For example, to use the Kore voice for English (United States) using the Chirp 3: HD voices model, you would specify it as en-US-Chirp3-HD-Kore.