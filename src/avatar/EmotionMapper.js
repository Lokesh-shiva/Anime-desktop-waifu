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
            'embarrassed': ['blush', 'shy', 'embarrassed', 'sad'],
            'curious': ['think', 'curious', 'wonder'],
            'neutral': ['neutral', 'normal', 'default'],
            // Shy/adorable personality mappings
            'shy': ['sad', 'shy', 'neutral'],
            'grateful': ['happy', 'joy', 'smile'],
            'hesitant': ['sad', 'neutral', 'shy'],
            'melancholic': ['sad', 'sorrow', 'neutral'],
            // Dynamic emotion arc labels
            'flustered': ['sad', 'embarrassed', 'blush'],
            'tender':    ['happy', 'smile', 'joy'],
            'calm':      ['neutral', 'default', 'normal'],
            'longing':   ['sad', 'neutral', 'sorrow'],
            'lonely':    ['sad', 'sorrow', 'neutral'],
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
                [PARAM_IDS.EYE_BALL_Y]: -0.5,
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
                [PARAM_IDS.EYE_BALL_Y]: -0.5,
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
                [PARAM_IDS.BROW_R_Y]: 1.0
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
                [PARAM_IDS.SKIRT_EXPAND]: 0.5       // VT_ELF: excited skirt puff
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
                [PARAM_IDS.ANGLE_Z]: 4
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
                [PARAM_IDS.EYE_BALL_Y]: -0.3,
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

        const preset = presets[label] || presets['neutral'];
        if (!preset) return null;

        // Overlay/visibility params are binary switches — they must reach their
        // full value to trigger the visual effect. Do NOT scale them by intensity.
        const OVERLAY_PARAMS = new Set([
            PARAM_IDS.HAPPY_VIS,    // Param15   — sparkle effect
            PARAM_IDS.ANGER_VIS,    // Angervis  — anger effect
            PARAM_IDS.HATE_VIS,     // ParamHateVis — disgust effect
            PARAM_IDS.SWEAT_VIS,    // ParamSweatVis — sweat/nervousness drops
        ]);

        const scaled = {};
        for (const [paramId, value] of Object.entries(preset)) {
            scaled[paramId] = OVERLAY_PARAMS.has(paramId) ? value : value * intensity;
        }
        return scaled;
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
