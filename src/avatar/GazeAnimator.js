/**
 * Gaze Animator
 * Drives EYE_BALL_X and EYE_BALL_Y based on active emotion.
 *
 * Each emotion has a "gaze target" — where the eyes naturally drift when
 * feeling that way. Micro-wander keeps the gaze alive and non-frozen.
 *
 * Rules:
 * - Owns EYE_BALL_X and EYE_BALL_Y exclusively — no other system writes these
 * - Applied AFTER the emotion conflict guard in AvatarController._onTick
 * - Lerps smoothly toward each new target so gaze shifts feel natural
 */

import { PARAM_IDS } from './avatar-config.js';

// Per-emotion gaze targets: { x, y }
// X: -1 = look left,  +1 = look right
// Y: -1 = look down,  +1 = look up
const GAZE_TARGETS = {
    // ── Upward / engaged ──────────────────────────────────────────────────────
    happy:       { x:  0.00, y:  0.25 },  // bright, lifted gaze
    excited:     { x:  0.10, y:  0.35 },  // animated, upward energy
    curious:     { x:  0.35, y:  0.30 },  // leaning into something interesting
    surprised:   { x:  0.00, y:  0.40 },  // wide open, upward
    love:        { x:  0.00, y:  0.10 },  // soft warm forward gaze
    tender:      { x:  0.00, y:  0.05 },  // gentle near-forward
    grateful:    { x:  0.00, y:  0.15 },  // open, looking slightly up at you
    kind:        { x:  0.00, y:  0.10 },  // warm forward

    // ── Forward / neutral ─────────────────────────────────────────────────────
    determined:  { x:  0.00, y:  0.00 },  // locked direct stare
    calm:        { x:  0.00, y: -0.10 },  // relaxed, slightly below center
    neutral:     { x:  0.00, y:  0.00 },

    // ── Aside / evasive ───────────────────────────────────────────────────────
    smug:        { x:  0.45, y:  0.05 },  // dismissive glance aside
    playful:     { x:  0.40, y:  0.15 },  // mischievous side-eye
    confused:    { x:  0.40, y:  0.25 },  // puzzled, looking at something up-right

    // ── Downward / withdrawn ──────────────────────────────────────────────────
    shy:         { x: -0.25, y: -0.55 },  // avoiding eye contact, down-left
    embarrassed: { x: -0.30, y: -0.60 },  // very avoidant, floor-looking
    flustered:   { x: -0.25, y: -0.50 },  // similar to shy
    hesitant:    { x:  0.20, y: -0.30 },  // uncertain, looking down-right
    sad:         { x: -0.15, y: -0.50 },  // withdrawn, floor gaze
    lonely:      { x: -0.20, y: -0.45 },  // withdrawn
    melancholic: { x: -0.15, y: -0.40 },  // wistful, soft down
    longing:     { x: -0.35, y:  0.20 },  // looking away into distance
    crying:      { x:  0.00, y: -0.50 },  // eyes down, looking at nothing
    sleepy:      { x:  0.00, y: -0.65 },  // heavy drooping

    // ── Alert / tense ─────────────────────────────────────────────────────────
    scared:      { x: -0.20, y:  0.10 },  // darting aside, alert
    anger:       { x:  0.00, y: -0.10 },  // direct low stare
    disgusted:   { x: -0.30, y:  0.00 },  // averted in distaste
};

// Micro-wander radius per emotion — how much the gaze drifts around its target
const GAZE_WANDER = {
    shy:         0.04,  // tiny nervous flicker — doesn't want to be caught looking
    embarrassed: 0.03,
    flustered:   0.04,
    playful:     0.10,  // active, darting
    curious:     0.10,
    confused:    0.09,
    scared:      0.12,  // fast darting eyes
    sleepy:      0.02,  // barely moving
    calm:        0.03,
    tender:      0.03,
    longing:     0.04,
    default:     0.06
};

const LERP_SPEED  = 1.8;   // how fast gaze moves toward target (units/sec)
const WANDER_SPEED = 0.4;  // oscillation speed of micro-wander

export class GazeAnimator {
    constructor(capabilityRegistry) {
        this.registry = capabilityRegistry;
        this._targetX = 0;
        this._targetY = 0;
        this._currentX = 0;
        this._currentY = 0;
        // Random start phases so multiple instances never look identical
        this._wanderPhaseX = Math.random() * Math.PI * 2;
        this._wanderPhaseY = Math.random() * Math.PI * 2;
        this._wanderRadius = GAZE_WANDER.default;

        // ── Micro-saccade state ───────────────────────────────────────────────
        // Saccades are fast, ballistic eye jumps to a new fixation point.
        // Each jump decays back to the gaze target quickly (~150 ms half-life).
        this._saccadeX        = 0;
        this._saccadeY        = 0;
        this._saccadeTimer    = Math.random() * 2.0;   // stagger first saccade
        this._saccadeInterval = 1.8 + Math.random() * 2.5;
    }

    setRegistry(registry) {
        this.registry = registry;
    }

    /**
     * Switch gaze target to match an emotion.
     * @param {string|null} label  - emotion label, null resets to neutral
     * @param {number}      intensity - 0–1, scales how far gaze shifts
     */
    setEmotion(label, intensity = 1.0) {
        const target = (label && GAZE_TARGETS[label]) || GAZE_TARGETS.neutral;
        // At low intensity emotions shift gaze less — minimum 40% of target offset
        const scale = 0.4 + intensity * 0.6;
        this._targetX = target.x * scale;
        this._targetY = target.y * scale;
        this._wanderRadius = (GAZE_WANDER[label] || GAZE_WANDER.default) * scale;
    }

    /**
     * Advance gaze and return current EYE_BALL_X/Y parameter values.
     * @param {number} dt - delta time in seconds
     * @returns {Object} paramId → value map (empty if model has no eye ball params)
     */
    update(dt) {
        if (!this.registry) return {};
        if (!this.registry.getCapabilities().hasEyeBallXY) return {};

        // Advance wander phases with slight cross-modulation for irregular feel
        this._wanderPhaseX += dt * WANDER_SPEED * (0.8 + Math.sin(this._wanderPhaseY) * 0.3);
        this._wanderPhaseY += dt * WANDER_SPEED * (0.9 + Math.cos(this._wanderPhaseX) * 0.2);

        const wanderX = Math.sin(this._wanderPhaseX) * this._wanderRadius;
        const wanderY = Math.cos(this._wanderPhaseY * 1.3) * this._wanderRadius;

        // ── Micro-saccade ─────────────────────────────────────────────────────
        // Fire a small ballistic jump every 1.8–4.3 s, then decay back quickly.
        this._saccadeTimer += dt;
        if (this._saccadeTimer >= this._saccadeInterval) {
            const angle = Math.random() * Math.PI * 2;
            const mag   = 0.04 + Math.random() * 0.07;
            this._saccadeX        = Math.cos(angle) * mag;
            this._saccadeY        = Math.sin(angle) * mag * 0.5;  // less vertical range
            this._saccadeTimer    = 0;
            this._saccadeInterval = 1.8 + Math.random() * 2.5;
        }
        // Exponential decay: ~150 ms half-life  (0.001^(dt*6.7) ≈ e^(-dt/0.145))
        const decay       = Math.pow(0.001, dt * 6.7);
        this._saccadeX   *= decay;
        this._saccadeY   *= decay;

        // Lerp current toward (target + wander + saccade)
        const lerpFactor = Math.min(1, LERP_SPEED * dt);
        this._currentX += (this._targetX + wanderX + this._saccadeX - this._currentX) * lerpFactor;
        this._currentY += (this._targetY + wanderY + this._saccadeY - this._currentY) * lerpFactor;

        return {
            [PARAM_IDS.EYE_BALL_X]: this._currentX,
            [PARAM_IDS.EYE_BALL_Y]: this._currentY
        };
    }
}
