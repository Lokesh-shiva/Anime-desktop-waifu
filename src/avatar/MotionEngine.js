/**
 * MotionEngine
 *
 * Drives continuous, organic motion for the avatar at all times.
 * Even in silence, Miko never freezes.
 *
 * Design rules:
 *   - Emotion is represented as continuous spring-damped signals (valence,
 *     arousal, confidence, shyness), NOT discrete states.
 *   - Head/body micro-motion uses layered incommensurate sinusoids —
 *     periods chosen so the combined waveform never visually loops.
 *   - All outputs have two categories:
 *       absolute  — BREATH (full value, applied BEFORE emotion params in
 *                   the monkey-patch so emotion can't break breathing)
 *       additive  — ANGLE_X/Y/Z, BODY_ANGLE_X/Z (delta applied AFTER
 *                   emotion params so micro-motion layers on top of any
 *                   emotion-driven pose rather than fighting it)
 *   - Nothing here ever calls renderer.setParameter. All writes go through
 *     AvatarController's monkey-patched internalModel.update.
 */

import { PARAM_IDS } from './avatar-config.js';

// ─── Tiny spring (mass-spring-damper) ────────────────────────────────────────
class Spring {
    /**
     * @param {number} stiffness  — spring constant (higher = snappier)
     * @param {number} damping    — friction (<1 overshoots, 1 = critical)
     * @param {number} initial    — starting value
     */
    constructor(stiffness = 4.0, damping = 1.4, initial = 0) {
        this.k        = stiffness;
        this.b        = damping;
        this.current  = initial;
        this.target   = initial;
        this.velocity = 0;
    }
    update(dt) {
        const force    = -this.k * (this.current - this.target) - this.b * this.velocity;
        this.velocity += force * dt;
        this.current  += this.velocity * dt;
        return this.current;
    }
    snapTo(v) {
        this.current  = v;
        this.target   = v;
        this.velocity = 0;
    }
}

// ─── Emotion → continuous signal targets ─────────────────────────────────────
//  valence:    -1 (negative) … +1 (positive)
//  arousal:     0 (very calm) … 1 (very energetic)
//  confidence:  0 (withdrawn) … 1 (assertive/upright)
//  shyness:     0 (open)      … 1 (very shy)
const EMOTION_SIGNALS = {
    happy:       { valence:  0.80, arousal: 0.55, confidence: 0.70, shyness: 0.00 },
    excited:     { valence:  0.90, arousal: 0.90, confidence: 0.80, shyness: 0.00 },
    playful:     { valence:  0.70, arousal: 0.70, confidence: 0.65, shyness: 0.10 },
    love:        { valence:  0.90, arousal: 0.30, confidence: 0.50, shyness: 0.20 },
    tender:      { valence:  0.80, arousal: 0.20, confidence: 0.50, shyness: 0.10 },
    calm:        { valence:  0.40, arousal: 0.10, confidence: 0.60, shyness: 0.00 },
    kind:        { valence:  0.70, arousal: 0.30, confidence: 0.60, shyness: 0.10 },
    grateful:    { valence:  0.80, arousal: 0.40, confidence: 0.55, shyness: 0.10 },
    curious:     { valence:  0.40, arousal: 0.55, confidence: 0.50, shyness: 0.05 },
    surprised:   { valence:  0.10, arousal: 0.85, confidence: 0.30, shyness: 0.00 },
    determined:  { valence:  0.30, arousal: 0.75, confidence: 0.95, shyness: 0.00 },
    smug:        { valence:  0.30, arousal: 0.50, confidence: 0.95, shyness: 0.00 },
    confused:    { valence: -0.10, arousal: 0.40, confidence: 0.20, shyness: 0.20 },
    hesitant:    { valence: -0.10, arousal: 0.25, confidence: 0.20, shyness: 0.40 },
    shy:         { valence:  0.20, arousal: 0.30, confidence: 0.10, shyness: 0.85 },
    embarrassed: { valence: -0.20, arousal: 0.65, confidence: 0.10, shyness: 0.90 },
    flustered:   { valence:  0.00, arousal: 0.60, confidence: 0.10, shyness: 0.80 },
    sad:         { valence: -0.70, arousal: 0.10, confidence: 0.20, shyness: 0.30 },
    lonely:      { valence: -0.70, arousal: 0.10, confidence: 0.20, shyness: 0.40 },
    melancholic: { valence: -0.50, arousal: 0.15, confidence: 0.30, shyness: 0.20 },
    longing:     { valence: -0.30, arousal: 0.20, confidence: 0.30, shyness: 0.30 },
    crying:      { valence: -0.90, arousal: 0.40, confidence: 0.10, shyness: 0.30 },
    sleepy:      { valence:  0.10, arousal: 0.00, confidence: 0.30, shyness: 0.10 },
    anger:       { valence: -0.80, arousal: 0.85, confidence: 0.75, shyness: 0.00 },
    angry:       { valence: -0.80, arousal: 0.85, confidence: 0.75, shyness: 0.00 },
    disgusted:   { valence: -0.70, arousal: 0.55, confidence: 0.65, shyness: 0.00 },
    scared:      { valence: -0.65, arousal: 0.85, confidence: 0.10, shyness: 0.10 },
    dark:        { valence: -0.60, arousal: 0.45, confidence: 0.75, shyness: 0.00 },
    neutral:     { valence:  0.00, arousal: 0.15, confidence: 0.50, shyness: 0.00 },
};

// ─── Oscillator banks ─────────────────────────────────────────────────────────
// Periods are mutually irrational (no two are integer multiples) so combined
// motion never visually loops in a session. Amplitudes in Live2D param units
// (same scale as ParamAngleX range -30…+30).
// Boosted so organic wobble is clearly visible above cursor-driven head movement.
const OSC_HEAD_X = [
    { freq: 0.137, amp: 2.80 },  // ~7.3 s  — slow wide drift
    { freq: 0.085, amp: 1.60 },  // ~11.8 s — medium
    { freq: 0.223, amp: 0.60 },  // ~4.5 s  — fast subtle
];
const OSC_HEAD_Y = [
    { freq: 0.114, amp: 1.50 },  // ~8.8 s
    { freq: 0.075, amp: 0.90 },  // ~13.3 s
    { freq: 0.177, amp: 0.35 },  // ~5.6 s
];
// Z drives tilt/sway — replaces IdleAnimator's simple sine sway
const OSC_HEAD_Z = [
    { freq: 0.103, amp: 2.20 },  // ~9.7 s  — primary sway (≈ old 3° idle amplitude)
    { freq: 0.163, amp: 1.00 },  // ~6.1 s  — secondary
    { freq: 0.251, amp: 0.38 },  // ~4.0 s  — high-freq ripple
];
const OSC_BODY_X = [
    { freq: 0.112, amp: 2.00 },  // ~8.9 s
    { freq: 0.071, amp: 1.00 },  // ~14.1 s
];
const OSC_BODY_Z = [
    { freq: 0.091, amp: 1.40 },  // ~11.0 s
    { freq: 0.141, amp: 0.60 },  // ~7.1 s
];

/** Sum a bank of oscillators at elapsed time t (seconds). */
function evalOsc(bank, t) {
    let v = 0;
    for (const o of bank) v += Math.sin(t * o.freq * Math.PI * 2) * o.amp;
    return v;
}

// ─────────────────────────────────────────────────────────────────────────────

export class MotionEngine {
    constructor(capabilityRegistry) {
        this.registry = capabilityRegistry;

        // Elapsed time
        this._time = 0;

        // Random phase offsets — each instance feels unique
        this._ph = {
            hx: Math.random() * 83,
            hy: Math.random() * 83 + 40,
            hz: Math.random() * 83 + 20,
            bx: Math.random() * 83 + 60,
            bz: Math.random() * 83 + 10,
        };

        // Emotion signal springs (all start at neutral)
        this._sig = {
            valence:    new Spring(2.5, 1.3,  0.0),
            arousal:    new Spring(3.0, 1.5,  0.15),
            confidence: new Spring(2.5, 1.3,  0.5),
            shyness:    new Spring(4.0, 1.6,  0.0),
        };

        // Motion amplitude spring — arousal expands it
        this._ampSpr = new Spring(2.0, 1.2, 1.0);
        this._ampSpr.snapTo(1.0);

        // Organic breathing
        this._breathPhase = Math.random() * Math.PI * 2;

        // Anticipation transient (pre-speech reaction)
        this._antTime    = 0;   // seconds remaining
        this._antMaxTime = 0.5;

        // Outputs (populated each update, read by AvatarController's monkey-patch)
        this.absolute = {};
        this.additive = {};
    }

    setRegistry(registry) {
        this.registry = registry;
    }

    /**
     * Map emotion label + intensity to signal spring targets.
     * Signals drift smoothly — they don't snap.
     * @param {string} label
     * @param {number} intensity 0–1
     */
    setEmotionSignals(label, intensity = 1.0) {
        const sig   = EMOTION_SIGNALS[label] || EMOTION_SIGNALS.neutral;
        const scale = 0.5 + intensity * 0.5;   // minimum 50% of target

        this._sig.valence.target    = sig.valence    * scale;
        this._sig.arousal.target    = sig.arousal    * scale;
        this._sig.confidence.target = sig.confidence;           // confidence independent of intensity
        this._sig.shyness.target    = sig.shyness    * scale;

        // Livelier motion when aroused
        this._ampSpr.target = 0.75 + sig.arousal * 0.70;

        console.log(`[MotionEngine] Signals → ${label} (×${intensity.toFixed(2)}):`,
            `shyness→${(sig.shyness*scale).toFixed(2)}`,
            `arousal→${(sig.arousal*scale).toFixed(2)}`,
            `confidence→${sig.confidence.toFixed(2)}`);
    }

    /**
     * Return to neutral (or a soft baseline residual after emotion decay).
     * @param {string} baselineLabel
     * @param {number} baselineIntensity — 0 for full neutral
     */
    resetToNeutral(baselineLabel = 'neutral', baselineIntensity = 0) {
        if (baselineIntensity > 0.1 && baselineLabel !== 'neutral') {
            this.setEmotionSignals(baselineLabel, baselineIntensity * 0.35);
        } else {
            const n = EMOTION_SIGNALS.neutral;
            this._sig.valence.target    = n.valence;
            this._sig.arousal.target    = n.arousal;
            this._sig.confidence.target = n.confidence;
            this._sig.shyness.target    = n.shyness;
            this._ampSpr.target         = 1.0;
        }
    }

    /**
     * Trigger anticipation micro-reaction ~150–250 ms before TTS starts.
     * Creates a subtle inhale / gaze-lift / slight tension effect.
     */
    primeForSpeech() {
        this._antTime    = this._antMaxTime;
        console.log('[MotionEngine] Anticipation fired — head lift starting');
    }

    /**
     * Advance all motion state by dt seconds.
     * Populates this.absolute (BREATH) and this.additive (head/body deltas).
     * @param {number} dt — delta seconds
     * @returns {{ absolute: Object, additive: Object }}
     */
    update(dt) {
        this._time += dt;
        const t = this._time;

        // ── Signal springs ─────────────────────────────────────────────────────
        const v   = this._sig.valence.update(dt);
        const a   = this._sig.arousal.update(dt);
        const c   = this._sig.confidence.update(dt);
        const shy = this._sig.shyness.update(dt);
        const amp = Math.max(0.5, this._ampSpr.update(dt));

        // ── Organic breathing ──────────────────────────────────────────────────
        // Arousal speeds up rate: calm ~14/min, energetic ~20/min
        const breathRate = (14 + a * 6) / 60;   // breaths per second
        this._breathPhase += dt * breathRate * Math.PI * 2;
        if (this._breathPhase > Math.PI * 2) this._breathPhase -= Math.PI * 2;

        // Asymmetric cycle: quick inhale (35 %), slow exhale (65 %)
        const bp      = (this._breathPhase % (Math.PI * 2)) / (Math.PI * 2);
        const breathV = bp < 0.35
            ? Math.sin((bp / 0.35) * Math.PI * 0.5)
            : Math.cos(((bp - 0.35) / 0.65) * Math.PI * 0.5);

        // ── Micro head motion ──────────────────────────────────────────────────
        let headX = evalOsc(OSC_HEAD_X, t + this._ph.hx) * amp;
        let headY = evalOsc(OSC_HEAD_Y, t + this._ph.hy) * amp;
        let headZ = evalOsc(OSC_HEAD_Z, t + this._ph.hz) * amp;

        // Signal-driven posture modulation — scaled to be clearly visible
        headY += c * 3.5 - shy * 5.5;             // confidence lifts, shyness dips
        headZ += -shy * 8.0;                       // shyness tilts head clearly forward

        // ── Arousal energy — base restlessness + excited burst ────────────────
        // IMPORTANT: these inline sin/cos use ω directly (rad/s), NOT Hz.
        //   period = 2π / ω   e.g.  ω=3.14 → period≈2.0 s
        //                            ω=7.85 → period≈0.8 s
        //                            ω=15.7 → period≈0.4 s
        // evalOsc() uses freq*2π internally so its values ARE in Hz — don't mix them.

        // General alive-ness at any elevated arousal (period ≈ 4 s)
        headX += a * 2.5 * Math.sin(t * 1.57);

        // Quadratic excited burst — only very high arousal triggers this strongly.
        // Three frequencies to create chaotic unpredictable energy, not a simple wobble.
        const aExcite = a * a;  // e.g. 0.81 for full excited

        // Big sweep X  (period ≈ 2.0 s) — wide restless side-to-side sweep
        headX += aExcite * 10.0 * Math.sin(t * 3.14 + this._ph.hx * 0.1);
        // Rapid flick X (period ≈ 0.8 s) — fast visible head jerk
        headX += aExcite * 6.0  * Math.sin(t * 7.85 + 1.2);
        // Fast quiver X (period ≈ 0.4 s) — high-freq excited trembling
        headX += aExcite * 3.0  * Math.sin(t * 15.7 + this._ph.hx * 0.3);

        // Excited nodding Y (period ≈ 1.5 s + 0.6 s)
        headY += aExcite * 5.5  * Math.sin(t * 4.19 + 0.5);
        headY += aExcite * 2.5  * Math.sin(t * 10.5 + 1.8);

        // Energetic Z tilt (period ≈ 3.0 s + 1.0 s)
        headZ += aExcite * 6.0  * Math.cos(t * 2.09 + 0.4);
        headZ += aExcite * 4.0  * Math.cos(t * 6.28 + this._ph.hz * 0.2);

        // ── Nervous flutter — flustered / embarrassed / scared ─────────────────
        // shy × a product is large only when BOTH flustered AND wound up.
        // Use genuinely fast ω values (≥ 6 rad/s) so the tremor feels rapid,
        // clearly different from the slow idle base oscillators.
        const flutter = shy * Math.max(0, a - 0.25);

        headX += flutter * 6.0  * Math.sin(t * 10.5 + this._ph.hx * 0.2); // ~0.60 s
        headZ += flutter * 4.0  * Math.cos(t * 14.0 + 0.7);                // ~0.45 s
        headY += flutter * 3.0  * Math.sin(t * 6.28 + 1.5);                // ~1.00 s
        headX += flutter * 3.5  * Math.sin(t * 17.3 + 0.9);                // ~0.36 s
        headZ += flutter * 2.5  * Math.cos(t * 12.6 + this._ph.hz * 0.3); // ~0.50 s

        // ── Body sway (independent of head) ───────────────────────────────────
        let bodyX = evalOsc(OSC_BODY_X, t + this._ph.bx) * amp * 0.75;
        let bodyZ = evalOsc(OSC_BODY_Z, t + this._ph.bz) * amp * 0.55;
        // Excited body rocking — torso energized (period ≈ 1.5 s + 1.2 s)
        bodyX += aExcite * 5.0  * Math.sin(t * 4.19 + 0.3);
        bodyZ += aExcite * 3.0  * Math.cos(t * 5.24 + 1.1);

        // ── Anticipation transient ─────────────────────────────────────────────
        if (this._antTime > 0) {
            this._antTime -= dt;
            // Bell-shaped envelope over the anticipation window
            const progress = 1.0 - Math.max(0, this._antTime / this._antMaxTime);
            const antAmp   = Math.sin(progress * Math.PI);
            headY += antAmp * 5.0;    // visible head lift (breath in before speaking)
            headZ -= antAmp * 2.5;    // noticeable tilt
            if (this._antTime <= 0) this._antTime = 0;
        }

        // ── Store outputs ──────────────────────────────────────────────────────
        this.absolute = {
            [PARAM_IDS.BREATH]: Math.max(0, Math.min(1, breathV)),
        };

        // Additive deltas — applied AFTER emotion params in monkey-patch
        this.additive = {
            [PARAM_IDS.ANGLE_X]:      headX,
            [PARAM_IDS.ANGLE_Y]:      headY,
            [PARAM_IDS.ANGLE_Z]:      headZ,
            [PARAM_IDS.BODY_ANGLE_X]: bodyX,
            [PARAM_IDS.BODY_ANGLE_Z]: bodyZ,
        };

        return { absolute: this.absolute, additive: this.additive };
    }
}
