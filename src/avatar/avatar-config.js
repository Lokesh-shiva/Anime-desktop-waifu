/**
 * Avatar Configuration
 * Constants and mappings for the Live2D avatar system
 * 
 * This file contains NO logic - only configuration values.
 * Parameter names are discovered from the model, not hardcoded assumptions.
 */

// Signal types for IPC communication
export const AVATAR_SIGNALS = Object.freeze({
    STATE_CHANGE: 'avatar:state',
    TONE_HINT: 'avatar:tone',
    TYPING_RHYTHM: 'avatar:rhythm',
    RESPONSE_TIMING: 'avatar:response',
    MOUTH_AMPLITUDE: 'avatar:mouth-amplitude',
    EXTERNAL_MOUTH_CONTROL: 'avatar:mouth-control'
});

// Animation timing configuration
export const TIMING = Object.freeze({
    // Transition durations (seconds)
    TRANSITION_DURATION: 0.5,
    MIN_MOTION_DURATION: 2.0,

    // Blink timing (seconds)
    BLINK_INTERVAL_MIN: 2.0,
    BLINK_INTERVAL_MAX: 5.0,
    BLINK_DURATION: 0.15,

    // Breathing cycle (seconds)
    BREATH_CYCLE: 4.0,

    // Mouth sync timing (seconds)
    MOUTH_CYCLE: 0.3,

    // Head sway for idle (seconds)
    IDLE_SWAY_CYCLE: 6.0,
    IDLE_SWAY_AMPLITUDE: 3.0
});

// Common Live2D parameter IDs (will be validated against model)
// These are standard Cubism parameter names
export const PARAM_IDS = Object.freeze({
    // Eyes
    EYE_L_OPEN: 'ParamEyeLOpen',
    EYE_R_OPEN: 'ParamEyeROpen',
    EYE_L_SMILE: 'ParamEyeLSmile',
    EYE_R_SMILE: 'ParamEyeRSmile',
    EYE_BALL_X: 'ParamEyeBallX',
    EYE_BALL_Y: 'ParamEyeBallY',

    // Mouth
    MOUTH_OPEN_Y: 'ParamMouthOpenY',
    MOUTH_FORM: 'ParamMouthForm',

    // Head angles
    ANGLE_X: 'ParamAngleX',
    ANGLE_Y: 'ParamAngleY',
    ANGLE_Z: 'ParamAngleZ',

    // Body angles
    BODY_ANGLE_X: 'ParamBodyAngleX',
    BODY_ANGLE_Y: 'ParamBodyAngleY',
    BODY_ANGLE_Z: 'ParamBodyAngleZ',

    // Eyebrows
    BROW_L_Y: 'ParamBrowLY',
    BROW_R_Y: 'ParamBrowRY',
    BROW_L_ANGLE: 'ParamBrowLAngle',
    BROW_R_ANGLE: 'ParamBrowRAngle',
    BROW_L_FORM: 'ParamBrowLForm',
    BROW_R_FORM: 'ParamBrowRForm',

    // Other
    BREATH: 'ParamBreath',
    CHEEK: 'ParamCheek',

    // VT_ELF model-specific parameters (exist on the Elf model)
    ELF_EAR:       'Param11',          // Elf ear droop/perk (-1 = droop, +1 = perk)
    ELF_EAR_WAVE:  'Param20',          // Ear wave animation
    SWEAT_VIS:     'ParamSweatVis',    // Nervousness/sweat drop visibility
    SKIRT_EXPAND:  'Paramskirtexpend', // Skirt puff (excitement/flustering) — lowercase 's'!
    TONGUE_VIS:    'Paramtoungevis',   // Tongue visibility
    BERO:          'ParamBero',        // Tongue wave
    ANGER_VIS:     'Angervis',         // Anger effect overlay
    HAPPY_VIS:     'Param15',          // Happiness sparkle effect
    HATE_VIS:      'ParamHateVis',     // Disgust/hate effect overlay

    // Alexia model-specific overlay parameters (from Alexia.cdi3.json)
    // Values in Alexia .exp3 files are 30 Add-blend — treat as binary overlays
    ALEXIA_SWEAT:       'Param44',     // 汗 — sweat drop (nervous/flustered)
    ALEXIA_QUESTION:    'Param43',     // 问号 — question mark (confused)
    ALEXIA_TONGUE:      'Param46',     // 舌头 — tongue out (playful)
    ALEXIA_STAR_EYES:   'Param55',     // 星星眼 — star eyes (love/excited)
    ALEXIA_DIZZY:       'Param56',     // 晕 — dizzy swirls (overwhelmed)
    ALEXIA_ANGRY:       'Param57',     // 生气 — anger vein
    ALEXIA_BLUSH:       'Param58',     // 脸红 — blush (shy/love/embarrassed)
    ALEXIA_CRY:         'Param59',     // 哭 — tears (crying/sad)
    ALEXIA_EYE_SQUINT_L:'Param51',     // 挤眼睛 L — smug/happy squint
    ALEXIA_EYE_SQUINT_R:'Param52',     // 挤眼睛 R — smug/happy squint
    ALEXIA_CHEEK_PUFF:  'Param21',     // 鼓脸 — pouty/flustered
    ALEXIA_BIG_SMILE:   'Param60'      // 大笑 — bright toothy smile (cheerful, distinct from villain grin)
});

// State behavior presets
export const STATE_BEHAVIORS = Object.freeze({
    IDLE: {
        blinkEnabled: true,
        breathingEnabled: true,
        headSwayEnabled: true,
        mouthEnabled: false,
        expression: 'neutral'
    },
    THINKING: {
        blinkEnabled: false, // Reduced blinking when thinking
        breathingEnabled: true,
        headSwayEnabled: false,
        mouthEnabled: false,
        expression: 'curious',
        headTilt: { x: 0, y: 5, z: 8 } // Slight head tilt
    },
    RESPONDING: {
        blinkEnabled: true,
        breathingEnabled: true,
        headSwayEnabled: false,
        mouthEnabled: true, // Mouth sync active
        expression: 'neutral'
    }
});

// Typing rhythm behaviors
export const RHYTHM_BEHAVIORS = Object.freeze({
    fast: {
        headTilt: { x: 0, y: 0, z: -5 }, // Slight attentive tilt
        eyeFocus: true,
        expression: 'attentive'
    },
    slow: {
        headTilt: { x: 0, y: 0, z: 0 },
        eyeFocus: false,
        expression: 'relaxed'
    },
    normal: {
        headTilt: { x: 0, y: 0, z: 0 },
        eyeFocus: false,
        expression: 'neutral'
    }
});

// Tone hint to expression mapping
export const TONE_EXPRESSIONS = Object.freeze({
    calm: {
        eyeSmile: 0.2,
        browY: 0,
        mouthForm: 0.1
    },
    neutral: {
        eyeSmile: 0,
        browY: 0,
        mouthForm: 0
    },
    energetic: {
        eyeSmile: 0.4,
        browY: 0.2,
        mouthForm: 0.3
    }
});

// Default model path
export const DEFAULT_MODEL_PATH = '../2D_Livemodel/tuzi mian.model3.json';

// Avatar window settings
export const WINDOW_CONFIG = Object.freeze({
    WIDTH: 400,
    HEIGHT: 600,
    ALWAYS_ON_TOP: true,
    TRANSPARENT: true,
    FRAME: false,
    CLICK_THROUGH: true
});
