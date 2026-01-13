# Exbabel Advanced TTS Feature Specification

Exbabel implements an industry-leading Text-to-Speech (TTS) architecture that combines the expressiveness of natural language prompting (Gemini-TTS) with the precision of SSML control (Chirp 3 HD).

## 1. Engine Hierarchy & Feature Set

The system uses a 4-tier routing strategy to balance performance, cost, and expressiveness.

| Tier | Engine | Input | Key Feature |
| :--- | :--- | :--- | :--- |
| **Ultra HD** | Gemini-TTS | Prompted Text | Emotional Intelligence |
| **Premium** | Chirp 3 HD | SSML | Specialized Prosody |
| **HD** | Neural2 | SSML | General Naturalness |
| **Standard** | Standard | SSML | Global Compatibility |

---

## 2. Gemini-TTS (Ultra HD Studio)

Gemini-TTS represents the "Studio" tier—the most advanced voices available. They do not use traditional SSML but instead understand natural language instructions.

### 2.1 Studio Voice Roster
These voices are high-fidelity models developed for expressive range:
- **Female:** Kore, Leda, Aoede, Achernar, Autonoe, Callirrhoe, Despina, Erinome, Gacrux, Laomedeia, Pulcherrima, Sulafat, Vindemiatrix, Zephyr.
- **Male:** Charon, Puck, Fenrir, Achird, Algenib, Algieba, Alnilam, Enceladus, Iapetus, Orus, Rasalgethi, Sadachbia, Sadaltager, Schedar, Umbriel, Zubenelgenubi.

### 2.2 Prompting Intelligence
Instead of coding pauses, you use **Prompt Presets** to guide the AI's delivery.

#### **General Category**
| ID | Style | Audio Characteristic |
| :--- | :--- | :--- |
| `preacher_warm_build` | Warm Build | Confident sermon cadence with gradual intensity. |
| `preacher_call_response` | Call & Response | Rhythmic preaching inviting congregation response. |
| `pastoral_comfort` | Pastoral Comfort | Caring, empathetic delivery for intimate moments. |
| `interpreter_neutral` | Interpreter | Professional clarity for translation. |
| `interpreter_slightly_warm` | Warm Interpreter | trained interpreter with a touch of warmth. |
| `stage_announcer` | Stage Announcer | Confident, energetic delivery for event hosting. |
| `church_announcements` | Church Host | Friendly and welcoming host style. |
| `audiobook_intimate` | Storyteller | Natural, fluid storytelling. |
| `news_anchor` | News Anchor | Professional, authoritative reporting style. |
| `support_agent_calm` | Calm Support | Helpful, patient, and calm delivery. |

#### **UPCI / Pentecostal "Fire Edition"**
| ID | Style | Audio Characteristic |
| :--- | :--- | :--- |
| `upci_apostolic_fire` | Apostolic Fire | Holy Ghost authority, fiery, authoritative delivery. |
| `upci_altar_call_fire` | Altar Call | Urgent, emotional, pleading for climactic moments. |
| `upci_teaching_authority` | Teaching Fire | Doctrinally strong, firm, with internal fire. |
| `upci_revival_meeting` | Revival Style | Explosive, high-energy camp meeting style. |
| `upci_pastoral_authority` | Firm Parental | Fatherly/motherly figure with firm spiritual authority. |
| `upci_interpreter_neutral_fire` | Pentecostal Interpreter | Optimized for translating high-energy preaching. |

### 2.3 Custom Prompts & Intensity
- **Custom Prompts:** Users can provide manual instructions (e.g., "Whisper-shout with intensity").
- **Intensity Modifiers (1-5):**
    - **1-2:** Measured, instructional.
    - **3:** Standard engagement (Default).
    - **4-5:** Maximum urgency, "Apostolic Fire".

---

## 3. Chirp 3 HD (Premium religious)

Chirp 3 HD is the specialized "workhorse" for religious translation. It is the only engine that supports **Dynamic Prosody Synthesis**.

### 3.1 Advanced SSML Features
- **Preaching Cadence:** Automatically slows down for emphasis and speeds up for narrative "builds".
- **Spiritual Delimiters:** Injects longer pauses (e.g., 800ms) after scriptural references.
- **Power Word Injection:** Wraps words like "Jesus", "Grace", and "Power" in `<emphasis level="strong">` tags.

### 3.2 Global Voice Mapping
Chirp 3 HD voices use consistent names across languages:
- *Example:* Choosing `Kore` in Spanish (`es-ES`) will use the Chirp 3 HD Spanish model.

---

## 4. Neural2 & Standard (Compatibility)

### 4.1 Neural2 (Wavenet)
- **Features:** High-speed synthesis, broad SSML support.
- **Use Case:** Best for general announcements or when specific emotional range isn't required.

### 4.2 Standard
- **Features:** Highest availability (70+ languages).
- **Use Case:** "Safe" fallback for rare dialects or languages not yet supported by Gemini or Chirp.

---

## 5. Roadmap: Future Addons

### 🏗️ Phase 2: Structural Awareness (Q2 2026)
- **Climax Detection:** Auto-switch to "Fire Edition" prompts when the system detects high-frequency punctuation or "Power Words".
- **Scripture Detection:** Auto-slow the rate when the speaker is quoting Bible verses.

### 🧠 Phase 3: Conversational Intelligence (Q3 2026)
- **Multi-Speaker Prompts:** Support for dialogue presets (e.g., "Conversation between a Teacher and a Student").
- **Custom Preset Creator:** Frontend UI to allow users to save their own prompt/intensity combinations as private presets.

### 🎙️ Phase 4: Voice Cloning (R&D)
- **Voice Match:** Implementation of cross-language voice matching (English speaker's voice characteristics applied to Spanish/French output).

---

## 6. Technical Reference

### Byte Limits (Gemini)
- **Prompt:** 4,000 bytes max.
- **Text:** 4,000 bytes max.
- **Combined:** 8,000 bytes max.

### API Options (WebSocket JSON)
#### `tts/start`
```json
{
  "type": "tts/start",
  "languageCode": "en-US",
  "voiceName": "Kore",
  "tier": "gemini",
  "promptPresetId": "upci_apostolic_fire",
  "intensity": 5,
  "ttsPrompt": "Speak with urgency"
}
```

### SSML Stripping (Gemini)
When using Gemini voices, the system automatically strips SSML tags from original text to extract **Plain Text**, ensuring Gemini receives only what it can process while preserving the intended narrative.
