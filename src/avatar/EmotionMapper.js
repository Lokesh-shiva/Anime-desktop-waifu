/**
 * Emotion Mapper
 * Maps semantic emotions to Live2D expressions OR parameter presets.
 * 
 * Strategy:
 * 1. Try to find a matching .exp3.json expression file
 * 2. If no file matches, return a parameter-based preset that directly
 *    manipulates face parameters (eye smile, brow, mouth, cheek) to
 *    simulate the emotion procedurally.
 * 
 * This ensures emotions work on ALL models, even those without any
 * expression files defined.
 */

import { PARAM_IDS } from './avatar-config.js';

export class EmotionMapper {
    constructor(capabilityRegistry) {
        this.registry = capabilityRegistry;
        this.currentExpression = null;
    }

    /**
     * Set the active capability registry
     * @param {CapabilityRegistry} registry 
     */
    setRegistry(registry) {
        this.registry = registry;
    }

    /**
     * Map emotion data to an expression name OR parameter preset
     * @param {Object} emotionData - { sentimentScore, label, intensity }
     * @returns {{ type: 'expression', name: string } | { type: 'parameters', params: Object } | null}
     */
    mapEmotion(emotionData) {
        if (!this.registry) return null;
        if (!emotionData || (!emotionData.label && !emotionData.emotionLabel)) return null;

        const label = (emotionData.label || emotionData.emotionLabel).toLowerCase();
        const intensity = emotionData.intensity || 0.8;

        // Strategy 1: Try exact expression file match
        if (this.registry.hasExpression(label)) {
            const name = this._getExactExpressionName(label);
            if (name) return { type: 'expression', name };
        }

        // Strategy 2: Try semantic mapping to common expression file names
        const mapped = this._semanticFileMapping(label);
        if (mapped && this.registry.hasExpression(mapped)) {
            const name = this._getExactExpressionName(mapped);
            if (name) return { type: 'expression', name };
        }

        // Strategy 3: Parameter-based preset (works on ALL models, preferred over
        // random expression guessing). We deliberately skip the "pick any expression"
        // approach — it produces wrong expressions (e.g. neutral→Anger).
        const paramPreset = this._getParameterPreset(label, intensity);
        if (paramPreset) {
            return { type: 'parameters', params: paramPreset };
        }

        return null;
    }

    /**
     * Map abstract emotion labels to common expression file names
     * @param {string} label 
     */
    _semanticFileMapping(label) {
        const map = {
            'happy': ['joy', 'smile', 'happy', 'glad'],
            'sad': ['sad', 'sorrow', 'cry', 'tears'],
            'anger': ['anger', 'angry', 'mad'],
            'playful': ['tongueout', 'tease', 'wink', 'fun'],
            'surprised': ['surprise', 'shock', 'wow'],
            'embarrassed': ['blush', 'shy', 'embarrassed'],
            'curious': ['think', 'curious', 'wonder'],
            'neutral': ['neutral', 'normal', 'default'],
            // Shy/adorable personality mappings
            // NOTE: 'sad' deliberately excluded — shy/flustered/embarrassed use
            // parameter presets, not expression files, to avoid wrong sad-face display
            'shy': ['shy'],
            'grateful': ['happy', 'joy', 'smile'],
            'hesitant': ['shy'],
            'melancholic': ['sad', 'sorrow', 'neutral'],
            // Dynamic emotion arc labels
            'flustered': ['embarrassed', 'blush'],
            'tender':    ['happy', 'smile', 'joy'],
            'calm':      ['neutral', 'default', 'normal'],
            'longing':   ['sorrow', 'neutral'],
            'lonely':    ['sorrow', 'neutral'],
            'kind':      ['happy', 'smile', 'joy']
        };

        const targets = map[label] || [];
        for (const target of targets) {
            if (this.registry.hasExpression(target)) {
                return target;
            }
        }
        return null;
    }

    /**
     * Get parameter presets that simulate emotions by directly
     * manipulating Live2D face parameters
     * @param {string} label - emotion label
     * @param {number} intensity - 0.0 to 1.0
     * @returns {Object|null} - Map of paramId to value
     */
    _getParameterPreset(label, intensity) {
        const presets = {
            'happy': {
                [PARAM_IDS.EYE_L_SMILE]: 1.0,
                [PARAM_IDS.EYE_R_SMILE]: 1.0,
                [PARAM_IDS.MOUTH_FORM]: 1.0,
                [PARAM_IDS.BROW_L_Y]: 0.3,
                [PARAM_IDS.BROW_R_Y]: 0.3,
                [PARAM_IDS.ANGLE_Z]: 5,
                [PARAM_IDS.HAPPY_VIS]: 1.0      // VT_ELF: happiness sparkle overlay
            },
            'sad': {
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: -0.8,
                [PARAM_IDS.BROW_L_Y]: -0.6,
                [PARAM_IDS.BROW_R_Y]: -0.6,
                [PARAM_IDS.ANGLE_Y]: -8,
                [PARAM_IDS.ANGLE_Z]: -3
            },
            'crying': {
                [PARAM_IDS.EYE_L_OPEN]: 0.4,
                [PARAM_IDS.EYE_R_OPEN]: 0.4,
                [PARAM_IDS.EYE_L_SMILE]: 0.6,
                [PARAM_IDS.EYE_R_SMILE]: 0.6,
                [PARAM_IDS.MOUTH_FORM]: -1.0,
                [PARAM_IDS.MOUTH_OPEN_Y]: 0.5,
                [PARAM_IDS.BROW_L_Y]: -1.0,
                [PARAM_IDS.BROW_R_Y]: -1.0,
                [PARAM_IDS.BROW_L_ANGLE]: 0.8,
                [PARAM_IDS.BROW_R_ANGLE]: 0.8,
                [PARAM_IDS.BROW_L_FORM]: 0.5,
                [PARAM_IDS.BROW_R_FORM]: 0.5,
                [PARAM_IDS.ANGLE_Y]: -12,
                [PARAM_IDS.ANGLE_Z]: -6,
                [PARAM_IDS.CHEEK]: 0.8,
                [PARAM_IDS.SWEAT_VIS]: 0.5        // VT_ELF: tears/distress indicator
            },
            'anger': {
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: -0.5,
                [PARAM_IDS.BROW_L_Y]: -1.0,
                [PARAM_IDS.BROW_R_Y]: -1.0,
                [PARAM_IDS.BROW_L_ANGLE]: -0.8,
                [PARAM_IDS.BROW_R_ANGLE]: -0.8,
                [PARAM_IDS.BROW_L_FORM]: -0.5,
                [PARAM_IDS.BROW_R_FORM]: -0.5,
                [PARAM_IDS.ANGER_VIS]: 0.8,    // VT_ELF: anger effect overlay
                [PARAM_IDS.ANGLE_X]: -5
            },
            'angry': {
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: -0.5,
                [PARAM_IDS.BROW_L_Y]: -1.0,
                [PARAM_IDS.BROW_R_Y]: -1.0,
                [PARAM_IDS.BROW_L_ANGLE]: -0.8,
                [PARAM_IDS.BROW_R_ANGLE]: -0.8,
                [PARAM_IDS.BROW_L_FORM]: -0.5,
                [PARAM_IDS.BROW_R_FORM]: -0.5,
                [PARAM_IDS.ANGER_VIS]: 0.8,    // VT_ELF: anger effect overlay
                [PARAM_IDS.ANGLE_X]: -5
            },
            'dark': {
                [PARAM_IDS.EYE_L_OPEN]: 0.5,
                [PARAM_IDS.EYE_R_OPEN]: 0.5,
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: -0.3,
                [PARAM_IDS.BROW_L_Y]: -0.8,
                [PARAM_IDS.BROW_R_Y]: -0.8,
                [PARAM_IDS.BROW_L_ANGLE]: -1.0,
                [PARAM_IDS.BROW_R_ANGLE]: -1.0,
                [PARAM_IDS.BROW_L_FORM]: -0.8,
                [PARAM_IDS.BROW_R_FORM]: -0.8,
                [PARAM_IDS.ANGER_VIS]: 1.0,    // VT_ELF: anger effect overlay
                [PARAM_IDS.ANGLE_X]: 0,
                [PARAM_IDS.ANGLE_Y]: -5,
                [PARAM_IDS.ANGLE_Z]: 0
            },
            'menacing': {
                [PARAM_IDS.EYE_L_OPEN]: 0.5,
                [PARAM_IDS.EYE_R_OPEN]: 0.5,
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: -0.3,
                [PARAM_IDS.BROW_L_Y]: -0.8,
                [PARAM_IDS.BROW_R_Y]: -0.8,
                [PARAM_IDS.BROW_L_ANGLE]: -1.0,
                [PARAM_IDS.BROW_R_ANGLE]: -1.0,
                [PARAM_IDS.ANGER_VIS]: 1.0,    // VT_ELF: anger effect overlay
                [PARAM_IDS.ANGLE_Y]: -5
            },
            'playful': {
                [PARAM_IDS.EYE_L_SMILE]: 0.8,
                [PARAM_IDS.EYE_R_SMILE]: 0.3,
                [PARAM_IDS.MOUTH_FORM]: 0.7,
                [PARAM_IDS.BROW_L_Y]: 0.5,
                [PARAM_IDS.BROW_R_Y]: 0.1,
                [PARAM_IDS.ANGLE_Z]: 8
            },
            'surprised': {
                [PARAM_IDS.EYE_L_OPEN]: 1.2,
                [PARAM_IDS.EYE_R_OPEN]: 1.2,
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_OPEN_Y]: 0.6,
                [PARAM_IDS.BROW_L_Y]: 1.0,
                [PARAM_IDS.BROW_R_Y]: 1.0,
                [PARAM_IDS.ELF_EAR_WAVE]: 0.65      // VT_ELF: startled ear flick
            },
            'embarrassed': {
                [PARAM_IDS.EYE_L_SMILE]: 0.6,
                [PARAM_IDS.EYE_R_SMILE]: 0.6,
                [PARAM_IDS.EYE_L_OPEN]: 0.6,
                [PARAM_IDS.EYE_R_OPEN]: 0.6,
                [PARAM_IDS.CHEEK]: 1.0,
                [PARAM_IDS.SWEAT_VIS]: 0.5,         // VT_ELF: nervousness indicator
                [PARAM_IDS.ANGLE_Z]: -8,
                [PARAM_IDS.ANGLE_Y]: -8,
                [PARAM_IDS.ANGLE_X]: -5,
                [PARAM_IDS.MOUTH_FORM]: 0.3,
                [PARAM_IDS.BROW_L_Y]: 0.3,
                [PARAM_IDS.BROW_R_Y]: 0.3,
                [PARAM_IDS.BROW_L_ANGLE]: 0.4,
                [PARAM_IDS.BROW_R_ANGLE]: 0.4
            },
            'excited': {
                [PARAM_IDS.EYE_L_OPEN]: 1.2,
                [PARAM_IDS.EYE_R_OPEN]: 1.2,
                [PARAM_IDS.EYE_L_SMILE]: 0.8,
                [PARAM_IDS.EYE_R_SMILE]: 0.8,
                [PARAM_IDS.MOUTH_OPEN_Y]: 0.8,
                [PARAM_IDS.MOUTH_FORM]: 1.0,
                [PARAM_IDS.BROW_L_Y]: 1.0,
                [PARAM_IDS.BROW_R_Y]: 1.0,
                [PARAM_IDS.BROW_L_FORM]: 0.5,
                [PARAM_IDS.BROW_R_FORM]: 0.5,
                [PARAM_IDS.CHEEK]: 0.6,
                [PARAM_IDS.ANGLE_Z]: 8,
                [PARAM_IDS.BODY_ANGLE_Z]: 5,
                [PARAM_IDS.HAPPY_VIS]: 0.8,         // VT_ELF: sparkle overlay
                [PARAM_IDS.SKIRT_EXPAND]: 0.5,      // VT_ELF: excited skirt puff
                [PARAM_IDS.ELF_EAR_WAVE]: 0.85      // VT_ELF: ears flapping with excitement
            },
            'sleepy': {
                [PARAM_IDS.EYE_L_OPEN]: 0.2,
                [PARAM_IDS.EYE_R_OPEN]: 0.15,
                [PARAM_IDS.EYE_L_SMILE]: 0.3,
                [PARAM_IDS.EYE_R_SMILE]: 0.3,
                [PARAM_IDS.MOUTH_OPEN_Y]: 0.4,
                [PARAM_IDS.MOUTH_FORM]: 0,
                [PARAM_IDS.BROW_L_Y]: -0.3,
                [PARAM_IDS.BROW_R_Y]: -0.3,
                [PARAM_IDS.ANGLE_Y]: -10,
                [PARAM_IDS.ANGLE_Z]: -8
            },
            'smug': {
                [PARAM_IDS.EYE_L_OPEN]: 0.7,
                [PARAM_IDS.EYE_R_OPEN]: 0.7,
                [PARAM_IDS.EYE_L_SMILE]: 0.6,
                [PARAM_IDS.EYE_R_SMILE]: 0.3,
                [PARAM_IDS.MOUTH_FORM]: 0.8,
                [PARAM_IDS.BROW_L_Y]: 0.6,
                [PARAM_IDS.BROW_R_Y]: -0.2,
                [PARAM_IDS.ANGLE_X]: 5,
                [PARAM_IDS.ANGLE_Z]: 4,
                [PARAM_IDS.TONGUE_VIS]: 0.6,    // VT_ELF: tongue peek — teasing
                [PARAM_IDS.BERO]: 0.3            // VT_ELF: subtle tongue wave
            },
            'love': {
                [PARAM_IDS.EYE_L_SMILE]: 1.0,
                [PARAM_IDS.EYE_R_SMILE]: 1.0,
                [PARAM_IDS.EYE_L_OPEN]: 0.6,
                [PARAM_IDS.EYE_R_OPEN]: 0.6,
                [PARAM_IDS.MOUTH_FORM]: 0.8,
                [PARAM_IDS.CHEEK]: 1.0,
                [PARAM_IDS.BROW_L_Y]: 0.3,
                [PARAM_IDS.BROW_R_Y]: 0.3,
                [PARAM_IDS.ANGLE_Z]: 5,
                [PARAM_IDS.ANGLE_Y]: -3,
                [PARAM_IDS.HAPPY_VIS]: 1.0          // VT_ELF: max happiness sparkle
            },
            'confused': {
                [PARAM_IDS.EYE_L_OPEN]: 1.0,
                [PARAM_IDS.EYE_R_OPEN]: 0.7,
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0.2,
                [PARAM_IDS.MOUTH_FORM]: -0.3,
                [PARAM_IDS.BROW_L_Y]: 0.6,
                [PARAM_IDS.BROW_R_Y]: -0.4,
                [PARAM_IDS.BROW_L_ANGLE]: 0.5,
                [PARAM_IDS.BROW_R_ANGLE]: -0.3,
                [PARAM_IDS.ANGLE_X]: 10,
                [PARAM_IDS.ANGLE_Z]: 6
            },
            'scared': {
                [PARAM_IDS.EYE_L_OPEN]: 1.3,
                [PARAM_IDS.EYE_R_OPEN]: 1.3,
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_OPEN_Y]: 0.4,
                [PARAM_IDS.MOUTH_FORM]: -0.6,
                [PARAM_IDS.BROW_L_Y]: 1.0,
                [PARAM_IDS.BROW_R_Y]: 1.0,
                [PARAM_IDS.BROW_L_ANGLE]: 0.8,
                [PARAM_IDS.BROW_R_ANGLE]: 0.8,
                [PARAM_IDS.ANGLE_Y]: -6,
                [PARAM_IDS.BODY_ANGLE_X]: -5
            },
            'disgusted': {
                [PARAM_IDS.EYE_L_OPEN]: 0.6,
                [PARAM_IDS.EYE_R_OPEN]: 0.5,
                [PARAM_IDS.EYE_L_SMILE]: 0.3,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: -1.0,
                [PARAM_IDS.MOUTH_OPEN_Y]: 0.2,
                [PARAM_IDS.BROW_L_Y]: -0.5,
                [PARAM_IDS.BROW_R_Y]: -0.8,
                [PARAM_IDS.BROW_L_ANGLE]: -0.6,
                [PARAM_IDS.ANGLE_X]: -6,
                [PARAM_IDS.ANGLE_Z]: -3,
                [PARAM_IDS.HATE_VIS]: 0.9           // VT_ELF: disgust/hate effect overlay
            },
            'determined': {
                [PARAM_IDS.EYE_L_OPEN]: 0.9,
                [PARAM_IDS.EYE_R_OPEN]: 0.9,
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: 0.3,
                [PARAM_IDS.BROW_L_Y]: -0.5,
                [PARAM_IDS.BROW_R_Y]: -0.5,
                [PARAM_IDS.BROW_L_ANGLE]: -0.5,
                [PARAM_IDS.BROW_R_ANGLE]: -0.5,
                [PARAM_IDS.ANGLE_Y]: 5
            },
            'curious': {
                [PARAM_IDS.BROW_L_Y]: 0.5,
                [PARAM_IDS.BROW_R_Y]: 0.3,
                [PARAM_IDS.ANGLE_X]: 8,
                [PARAM_IDS.ANGLE_Z]: 6,
                [PARAM_IDS.EYE_L_SMILE]: 0.2,
                [PARAM_IDS.EYE_R_SMILE]: 0.2
            },
            'neutral': {
                [PARAM_IDS.EYE_L_SMILE]: 0,
                [PARAM_IDS.EYE_R_SMILE]: 0,
                [PARAM_IDS.MOUTH_FORM]: 0,
                [PARAM_IDS.BROW_L_Y]: 0,
                [PARAM_IDS.BROW_R_Y]: 0,
                [PARAM_IDS.ANGLE_X]: 0,
                [PARAM_IDS.ANGLE_Y]: 0,
                [PARAM_IDS.ANGLE_Z]: 0,
                [PARAM_IDS.EYE_L_OPEN]: 1.0,
                [PARAM_IDS.EYE_R_OPEN]: 1.0,
                [PARAM_IDS.MOUTH_OPEN_Y]: 0,
                [PARAM_IDS.CHEEK]: 0
            },
            // Shy/Adorable Personality - VT_ELF Optimized
            'shy': {
                [PARAM_IDS.EYE_L_OPEN]: 0.4,
                [PARAM_IDS.EYE_R_OPEN]: 0.4,
                [PARAM_IDS.CHEEK]: 0.7,
                [PARAM_IDS.ANGLE_Y]: -10,
                [PARAM_IDS.BROW_L_Y]: -0.2,
                [PARAM_IDS.BROW_R_Y]: -0.2,
                [PARAM_IDS.MOUTH_FORM]: -0.1,
                [PARAM_IDS.ELF_EAR]: -0.3          // VT_ELF: drooped ears
            },
            'embarrassed': {
                [PARAM_IDS.EYE_L_OPEN]: 0.3,
                [PARAM_IDS.EYE_R_OPEN]: 0.3,
                [PARAM_IDS.CHEEK]: 1.0,
                [PARAM_IDS.MOUTH_FORM]: -0.3,
                [PARAM_IDS.ANGLE_Y]: -10,
                [PARAM_IDS.BROW_L_Y]: -0.1,
                [PARAM_IDS.BROW_R_Y]: -0.1,
                // VT_ELF-specific: Nervousness marker + ears back + skirt puff
                [PARAM_IDS.SWEAT_VIS]: 1.0,
                [PARAM_IDS.ELF_EAR]: -0.4,
                [PARAM_IDS.SKIRT_EXPAND]: 0.3
            },
            'grateful': {
                [PARAM_IDS.EYE_L_OPEN]: 0.7,
                [PARAM_IDS.EYE_R_OPEN]: 0.7,
                [PARAM_IDS.EYE_L_SMILE]: 0.6,
                [PARAM_IDS.EYE_R_SMILE]: 0.6,
                [PARAM_IDS.CHEEK]: 0.8,
                [PARAM_IDS.MOUTH_FORM]: 0.3,
                [PARAM_IDS.ELF_EAR]: 0.2,          // VT_ELF: perked ears
                [PARAM_IDS.ELF_EAR_WAVE]: 0.3,     // VT_ELF: gentle ear wave
                [PARAM_IDS.HAPPY_VIS]: 0.6          // VT_ELF: soft sparkle
            },
            'hesitant': {
                [PARAM_IDS.EYE_L_OPEN]: 0.5,
                [PARAM_IDS.EYE_R_OPEN]: 0.5,
                [PARAM_IDS.BROW_L_Y]: -0.3,
                [PARAM_IDS.BROW_R_Y]: -0.3,
                [PARAM_IDS.MOUTH_FORM]: -0.2,
                [PARAM_IDS.CHEEK]: 0.3,
                [PARAM_IDS.ELF_EAR]: -0.2,         // VT_ELF: slightly drooped ears
                [PARAM_IDS.SWEAT_VIS]: 0.6          // VT_ELF: mild nervousness
            },
            'melancholic': {
                [PARAM_IDS.EYE_L_OPEN]: 0.4,
                [PARAM_IDS.EYE_R_OPEN]: 0.4,
                [PARAM_IDS.BROW_L_Y]: -0.6,
                [PARAM_IDS.BROW_R_Y]: -0.6,
                [PARAM_IDS.MOUTH_FORM]: -0.4,
                [PARAM_IDS.ANGLE_Y]: -5,
                [PARAM_IDS.CHEEK]: 0.2,
                [PARAM_IDS.ELF_EAR]: -0.5,         // VT_ELF: drooped ears
                [PARAM_IDS.SWEAT_VIS]: 0.3          // VT_ELF: subtle uncertainty
            },
            'playful': {
                [PARAM_IDS.EYE_L_SMILE]: 0.8,
                [PARAM_IDS.EYE_R_SMILE]: 0.8,
                [PARAM_IDS.MOUTH_FORM]: 0.6,
                [PARAM_IDS.CHEEK]: 0.6,
                [PARAM_IDS.BROW_L_Y]: 0.2,
                [PARAM_IDS.TONGUE_VIS]: 1.0,        // VT_ELF: tongue out
                [PARAM_IDS.BERO]: 0.4,              // VT_ELF: tongue wave
                [PARAM_IDS.ELF_EAR]: 0.3,           // VT_ELF: perked ears
                [PARAM_IDS.SKIRT_EXPAND]: 0.4       // VT_ELF: playful skirt puff
            },
            // ── Dynamic emotion arc presets ────────────────────────────────────
            'flustered': {
                [PARAM_IDS.EYE_L_OPEN]: 0.35,
                [PARAM_IDS.EYE_R_OPEN]: 0.35,
                [PARAM_IDS.CHEEK]: 1.0,
                [PARAM_IDS.MOUTH_FORM]: 0.1,
                [PARAM_IDS.ANGLE_Y]: -8,
                [PARAM_IDS.ELF_EAR]: -0.3,          // VT_ELF: ears back
                [PARAM_IDS.SWEAT_VIS]: 0.8,          // VT_ELF: sweat drops
                [PARAM_IDS.SKIRT_EXPAND]: 0.35       // VT_ELF: skirt flutter
            },
            'tender': {
                [PARAM_IDS.EYE_L_OPEN]: 0.65,
                [PARAM_IDS.EYE_R_OPEN]: 0.65,
                [PARAM_IDS.EYE_L_SMILE]: 0.5,
                [PARAM_IDS.EYE_R_SMILE]: 0.5,
                [PARAM_IDS.MOUTH_FORM]: 0.3,
                [PARAM_IDS.CHEEK]: 0.55,
                [PARAM_IDS.ELF_EAR]: 0.15           // VT_ELF: slightly perked ears
            },
            'calm': {
                [PARAM_IDS.EYE_L_OPEN]: 0.75,
                [PARAM_IDS.EYE_R_OPEN]: 0.75,
                [PARAM_IDS.MOUTH_FORM]: 0.1,
                [PARAM_IDS.BROW_L_Y]: 0.1,
                [PARAM_IDS.BROW_R_Y]: 0.1,
                [PARAM_IDS.ANGLE_Y]: 3
            },
            'longing': {
                [PARAM_IDS.EYE_L_OPEN]: 0.55,
                [PARAM_IDS.EYE_R_OPEN]: 0.55,
                [PARAM_IDS.BROW_L_Y]: -0.2,
                [PARAM_IDS.BROW_R_Y]: -0.2,
                [PARAM_IDS.MOUTH_FORM]: -0.2,
                [PARAM_IDS.ANGLE_Y]: -5,
                [PARAM_IDS.ELF_EAR]: -0.2           // VT_ELF: drooped ears — wistful
            },
            'lonely': {
                [PARAM_IDS.EYE_L_OPEN]: 0.45,
                [PARAM_IDS.EYE_R_OPEN]: 0.45,
                [PARAM_IDS.BROW_L_Y]: -0.45,
                [PARAM_IDS.BROW_R_Y]: -0.45,
                [PARAM_IDS.MOUTH_FORM]: -0.35,
                [PARAM_IDS.CHEEK]: 0.15,
                [PARAM_IDS.ELF_EAR]: -0.4           // VT_ELF: drooped ears — withdrawn
            },
            'kind': {
                [PARAM_IDS.EYE_L_OPEN]: 0.8,
                [PARAM_IDS.EYE_R_OPEN]: 0.8,
                [PARAM_IDS.EYE_L_SMILE]: 0.4,
                [PARAM_IDS.EYE_R_SMILE]: 0.4,
                [PARAM_IDS.MOUTH_FORM]: 0.45,
                [PARAM_IDS.CHEEK]: 0.5,
                [PARAM_IDS.ELF_EAR]: 0.1,           // VT_ELF: gently perked ears
                [PARAM_IDS.HAPPY_VIS]: 0.4           // VT_ELF: soft warmth sparkle
            }
        };

        let preset = presets[label] || presets['neutral'];
        if (!preset) return null;

        // ── Alexia overlay injection ────────────────────────────────────────
        // Alexia shares Param11/Param15 with VT_ELF but those IDs mean
        // different things (sunglasses / unknown) on Alexia — so when we
        // detect Alexia, strip VT_ELF overlay keys and inject Alexia's own
        // rich overlay set (star eyes, blush, sweat, question, dizzy, etc.)
        const family = this.registry?.getCapabilities?.().modelFamily;
        if (family === 'alexia') {
            const stripped = {};
            const ELF_ONLY = new Set([
                PARAM_IDS.ELF_EAR, PARAM_IDS.ELF_EAR_WAVE,
                PARAM_IDS.HAPPY_VIS, PARAM_IDS.ANGER_VIS, PARAM_IDS.HATE_VIS,
                PARAM_IDS.SWEAT_VIS, PARAM_IDS.TONGUE_VIS, PARAM_IDS.BERO,
                PARAM_IDS.SKIRT_EXPAND
            ]);
            for (const [k, v] of Object.entries(preset)) {
                if (!ELF_ONLY.has(k)) stripped[k] = v;
            }
            // Cap EYE_L/R_SMILE to 0.35 on Alexia — higher values produce an
            // unnatural creepy grin on her art style. Alexia's Param51/52 overlay
            // (EYE_SQUINT) handles the "happy eyes" effect instead.
            const SMILE_CAP = 0.35;
            if (stripped[PARAM_IDS.EYE_L_SMILE] > SMILE_CAP) stripped[PARAM_IDS.EYE_L_SMILE] = SMILE_CAP;
            if (stripped[PARAM_IDS.EYE_R_SMILE] > SMILE_CAP) stripped[PARAM_IDS.EYE_R_SMILE] = SMILE_CAP;
            // Also cap MOUTH_FORM — her mouth rig is more expressive; full 1.0 looks jarring
            if (stripped[PARAM_IDS.MOUTH_FORM] > 0.6) stripped[PARAM_IDS.MOUTH_FORM] = 0.6;
            // Alexia-specific continuous param overrides — not binary overlays but
            // improve expression fidelity using her unique rig params
            const ALEXIA_BASE_OVERRIDES = {
                smug:    { [PARAM_IDS.ALEXIA_MOUTH_SKEW]: 0.65 }, // cocky asymmetric mouth tilt
                playful: { [PARAM_IDS.ALEXIA_MOUTH_SKEW]: 0.35 }, // cheeky subtle skew
            };
            const alexiaBaseOverrides = ALEXIA_BASE_OVERRIDES[label] || {};
            const alexiaLayer = this._alexiaOverlayFor(label);
            preset = { ...stripped, ...alexiaBaseOverrides, ...alexiaLayer };
        }

        // Overlay/visibility params are binary switches — they must reach their
        // full value to trigger the visual effect. Do NOT scale them by intensity.
        const OVERLAY_PARAMS = new Set([
            PARAM_IDS.HAPPY_VIS,    // Param15        — sparkle effect
            PARAM_IDS.ANGER_VIS,    // Angervis        — anger effect
            PARAM_IDS.HATE_VIS,     // ParamHateVis    — disgust effect
            PARAM_IDS.SWEAT_VIS,    // ParamSweatVis   — sweat/nervousness drops
            PARAM_IDS.TONGUE_VIS,   // Paramtoungevis  — tongue visibility (binary switch)
            // Alexia overlays — all Add-blend binary switches at value 30
            PARAM_IDS.ALEXIA_SWEAT, PARAM_IDS.ALEXIA_QUESTION, PARAM_IDS.ALEXIA_TONGUE,
            PARAM_IDS.ALEXIA_STAR_EYES, PARAM_IDS.ALEXIA_DIZZY,
            PARAM_IDS.ALEXIA_ANGRY, PARAM_IDS.ALEXIA_BLUSH, PARAM_IDS.ALEXIA_CRY,
            PARAM_IDS.ALEXIA_EYE_SQUINT_L, PARAM_IDS.ALEXIA_EYE_SQUINT_R,
            PARAM_IDS.ALEXIA_CHEEK_PUFF, PARAM_IDS.ALEXIA_BIG_SMILE
        ]);

        const scaled = {};
        for (const [paramId, value] of Object.entries(preset)) {
            scaled[paramId] = OVERLAY_PARAMS.has(paramId) ? value : value * intensity;
        }
        return scaled;
    }

    /**
     * Alexia-specific overlay layer per emotion.
     * Values are 30 (matches Alexia .exp3 Add-blend magnitude).
     */
    _alexiaOverlayFor(label) {
        const A = PARAM_IDS;
        const V = 30;
        // GRIN (Param54) = sharp toothy villain-style grin — only for smug/playful.
        // TONGUE (Param46) = tongue out — only for playful (genuinely cheeky moment).
        // Warm emotions (happy, love, excited, grateful) use eye squints only — natural soft look.
        const map = {
            // ── Warm / positive ────────────────────────────────────────────────
            happy:       { [A.ALEXIA_BIG_SMILE]: V, [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            excited:     { [A.ALEXIA_BIG_SMILE]: V, [A.ALEXIA_STAR_EYES]: V, [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            love:        { [A.ALEXIA_STAR_EYES]: V, [A.ALEXIA_BLUSH]: V, [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            grateful:    { [A.ALEXIA_BIG_SMILE]: V, [A.ALEXIA_BLUSH]: V, [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            // ── Soft / tender ──────────────────────────────────────────────────
            tender:      { [A.ALEXIA_BLUSH]: V, [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            kind:        { [A.ALEXIA_BLUSH]: V, [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            calm:        { [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            longing:     { [A.ALEXIA_BLUSH]: V, [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V },
            // ── Cheeky / smug ──────────────────────────────────────────────────
            smug:        { [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V }, // mouth_skew injected via base overrides
            playful:     { [A.ALEXIA_EYE_SQUINT_L]: V, [A.ALEXIA_EYE_SQUINT_R]: V }, // mouth_skew injected via base overrides
            // ── Nervous / embarrassed ──────────────────────────────────────────
            embarrassed: { [A.ALEXIA_SWEAT]: V, [A.ALEXIA_BLUSH]: V },
            flustered:   { [A.ALEXIA_SWEAT]: V, [A.ALEXIA_BLUSH]: V, [A.ALEXIA_DIZZY]: V },
            shy:         { [A.ALEXIA_BLUSH]: V },
            hesitant:    { [A.ALEXIA_SWEAT]: V },
            // ── Sad / heavy ────────────────────────────────────────────────────
            crying:      { [A.ALEXIA_CRY]: V, [A.ALEXIA_BLUSH]: V },
            sad:         { [A.ALEXIA_CRY]: V },
            melancholic: { [A.ALEXIA_SWEAT]: V },
            lonely:      { [A.ALEXIA_CRY]: V },
            // ── Confused / disoriented ─────────────────────────────────────────
            confused:    { [A.ALEXIA_QUESTION]: V },
            surprised:   { [A.ALEXIA_QUESTION]: V, [A.ALEXIA_DIZZY]: V },
            scared:      { [A.ALEXIA_SWEAT]: V, [A.ALEXIA_DIZZY]: V },
            // ── Anger / negative ───────────────────────────────────────────────
            anger:       { [A.ALEXIA_ANGRY]: V },
            angry:       { [A.ALEXIA_ANGRY]: V },
            dark:        { [A.ALEXIA_ANGRY]: V },
            menacing:    { [A.ALEXIA_ANGRY]: V },
            disgusted:   { [A.ALEXIA_CHEEK_PUFF]: V },
        };
        return map[label] || {};
    }

    /**
     * Get the exact case-sensitive expression name from the registry
     * @param {string} searchName 
     */
    _getExactExpressionName(searchName) {
        const lowerSearch = searchName.toLowerCase();
        const expressions = this.registry.getCapabilities().expressions;
        return expressions.find(e => e.toLowerCase() === lowerSearch) || null;
    }

    /**
     * Simple hash function for deterministic expression selection
     * @param {string} str 
     * @returns {number}
     */
    _hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }
}
