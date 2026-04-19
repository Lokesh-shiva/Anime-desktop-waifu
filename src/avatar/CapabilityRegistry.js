/**
 * Capability Registry
 * Dynamically detects and stores Live2D model capabilities.
 */

import { PARAM_IDS } from './avatar-config.js';

export class CapabilityRegistry {
    constructor() {
        this.capabilities = {
            hasBlink: false,
            hasMouth: false,
            hasHeadAngle: false,
            hasBodyAngle: false,
            hasPhysics: false,
            // Advanced detection
            hasEyeBallXY: false,
            hasAngleZ: false,
            hasBodyAngleX: false,
            hasBreath: false,
            hasCheek: false,
            hasBrowAngle: false,
            hasEyeSmile: false,
            // Expressions
            modelFamily: 'generic',
            expressions: [],
            // Motions: { groupName: count } — empty when model has no motion files
            motionGroups: {}
        };
        this.availableParams = new Set();
    }

    /**
     * Discover capabilities from a loaded Live2D model
     * @param {Live2DModel} model 
     * @param {string} modelPath
     */
    async discover(model, modelPath) {
        this.reset();

        if (!model) {
            console.warn('[CapabilityRegistry] No model provided for discovery');
            return this.capabilities;
        }

        // Discover Parameters
        if (model.internalModel && model.internalModel.coreModel) {
            try {
                const coreModel = model.internalModel.coreModel;

                if (coreModel._parameterIds) {
                    // Cubism 4 raw arrays
                    console.log('[CapabilityRegistry] Discovered parameters via _parameterIds');
                    coreModel._parameterIds.forEach(id => this.availableParams.add(id));
                } else if (coreModel.getParameterCount && coreModel.getParameterId) {
                    // Cubism 3 standard API
                    console.log('[CapabilityRegistry] Discovered parameters via getParameterId');
                    const paramCount = coreModel.getParameterCount();
                    for (let i = 0; i < paramCount; i++) {
                        this.availableParams.add(coreModel.getParameterId(i));
                    }
                } else if (model.internalModel.settings && model.internalModel.settings.parameterIds) {
                    console.log('[CapabilityRegistry] Discovered parameters via settings');
                    model.internalModel.settings.parameterIds.forEach(id => this.availableParams.add(id));
                } else {
                    console.warn('[CapabilityRegistry] Failed to identify parameter arrays on coreModel');
                }

                console.log('[CapabilityRegistry] Total Discovered:', this.availableParams.size, 'parameters');
                // Check VT_ELF overlay params specifically — if missing they'll fail silently
                const elfOverlays = ['Param15','Angervis','ParamHateVis','ParamSweatVis','Paramskirtexpend','Param11','Paramtoungevis','ParamBero'];
                const elfFound = elfOverlays.filter(p => this.availableParams.has(p)).length;
                const alexiaOverlays = ['Param44','Param43','Param46','Param54','Param55','Param56','Param57','Param58','Param59','Param51','Param52','Param21'];
                const alexiaFound = alexiaOverlays.filter(p => this.availableParams.has(p)).length;
                // Alexia shares Param11/Param15 with VT_ELF but with different meanings —
                // use the high-signal Alexia-only params (star eyes/blush/sweat) to decide.
                const isAlexia = this.availableParams.has('Param55')
                              && this.availableParams.has('Param58')
                              && this.availableParams.has('Param44');
                this.capabilities.modelFamily = isAlexia ? 'alexia' : (elfFound >= 4 ? 'vt_elf' : 'generic');
                console.log('[CapabilityRegistry] Model family:', this.capabilities.modelFamily,
                    `(elf=${elfFound}/${elfOverlays.length}, alexia=${alexiaFound}/${alexiaOverlays.length})`);
                this._detectFeatures();
            } catch (e) {
                console.warn('[CapabilityRegistry] Parameter discovery failed:', e.message);
            }
        } else {
            console.warn('[CapabilityRegistry] Model core not ready for parameter discovery');
        }

        // Discover Physics
        if (model.internalModel && model.internalModel.physicsMap && Object.keys(model.internalModel.physicsMap).length > 0) {
            this.capabilities.hasPhysics = true;
            console.log('[CapabilityRegistry] Physics detected');
        }

        // Discover Expressions
        if (model.internalModel && model.internalModel.settings && model.internalModel.settings.expressions) {
            try {
                // Usually an array of { name: string, file: string }
                this.capabilities.expressions = model.internalModel.settings.expressions
                    .map(exp => exp.name || (exp.file ? exp.file.replace('.exp3.json', '') : null))
                    .filter(Boolean);
                console.log('[CapabilityRegistry] Discovered expressions (from settings):', this.capabilities.expressions.join(', '));
            } catch (e) {
                console.warn('[CapabilityRegistry] Expression discovery failed:', e.message);
            }
        }

        // Discover Motions
        const motions = model.internalModel?.settings?.motions;
        if (motions && typeof motions === 'object') {
            for (const [group, list] of Object.entries(motions)) {
                if (Array.isArray(list) && list.length > 0) {
                    this.capabilities.motionGroups[group] = list.length;
                }
            }
            const groupNames = Object.keys(this.capabilities.motionGroups);
            if (groupNames.length > 0) {
                console.log('[CapabilityRegistry] Motion groups:', groupNames.map(g => `${g}(${this.capabilities.motionGroups[g]})`).join(', '));
            } else {
                console.log('[CapabilityRegistry] No motion groups found in this model');
            }
        }

        // If no expressions found, fallback to scanning folder via IPC
        if (this.capabilities.expressions.length === 0 && modelPath && window.avatarAPI?.getModelExpressions) {
            try {
                const looseExps = await window.avatarAPI.getModelExpressions(modelPath);
                if (looseExps && looseExps.length > 0) {
                    // Force inject them into Pixi settings
                    if (!model.internalModel.settings.expressions) {
                        model.internalModel.settings.expressions = [];
                    }

                    const expManager = model.internalModel.motionManager?.expressionManager;

                    let addedCount = 0;
                    for (const exp of looseExps) {
                        const name = exp.split(/[\\/]/).pop().replace('.exp3.json', '');

                        // Add to settings
                        const exists = model.internalModel.settings.expressions.find(e => e.name === name || e.file === exp);
                        if (!exists) {
                            model.internalModel.settings.expressions.push({ name: name, file: exp });

                            // Force inject them into Pixi definitions directly if manager exists
                            if (expManager && expManager.definitions) {
                                const defExists = expManager.definitions.find(e => e.name === name || e.file === exp);
                                if (!defExists) {
                                    expManager.definitions.push({ name: name, file: exp });
                                    addedCount++;

                                    // VERY IMPORTANT: Tell the manager to fetch the actual JSON file 
                                    // because it normally only does this once on startup based on model3.json!
                                    try {
                                        // The index is the new length - 1
                                        const newIndex = expManager.definitions.length - 1;
                                        // This is a private/internal method in pixi-live2d-display but required for loose files
                                        expManager.loadExpression(newIndex).catch(() => { });
                                    } catch (e) {
                                        // Ignore if method isn't available
                                    }
                                }
                            } else {
                                addedCount++;
                            }
                        }
                    }

                    this.capabilities.expressions = model.internalModel.settings.expressions
                        .map(exp => exp.name || (exp.file ? exp.file.replace('.exp3.json', '') : null))
                        .filter(Boolean);
                    console.log(`[CapabilityRegistry] Injected ${addedCount} loose folder expressions!`);
                }
            } catch (e) {
                console.warn('[CapabilityRegistry] IPC Expression discovery failed:', e.message);
            }
        }

        return this.capabilities;
    }

    /**
     * Map available parameters to higher-level capability flags
     */
    _detectFeatures() {
        // Basic
        this.capabilities.hasBlink = this.hasParam(PARAM_IDS.EYE_L_OPEN) || this.hasParam(PARAM_IDS.EYE_R_OPEN);
        this.capabilities.hasMouth = this.hasParam(PARAM_IDS.MOUTH_OPEN_Y);
        this.capabilities.hasHeadAngle = this.hasParam(PARAM_IDS.ANGLE_X) || this.hasParam(PARAM_IDS.ANGLE_Y);

        // Advanced
        this.capabilities.hasEyeBallXY = this.hasParam(PARAM_IDS.EYE_BALL_X) && this.hasParam(PARAM_IDS.EYE_BALL_Y);
        this.capabilities.hasAngleZ = this.hasParam(PARAM_IDS.ANGLE_Z);
        this.capabilities.hasBodyAngleX = this.hasParam(PARAM_IDS.BODY_ANGLE_X);
        this.capabilities.hasBodyAngle = this.hasParam(PARAM_IDS.BODY_ANGLE_X) || this.hasParam(PARAM_IDS.BODY_ANGLE_Y) || this.hasParam(PARAM_IDS.BODY_ANGLE_Z);
        this.capabilities.hasBreath = this.hasParam(PARAM_IDS.BREATH);
        this.capabilities.hasCheek = this.hasParam(PARAM_IDS.CHEEK);
        this.capabilities.hasBrowAngle = this.hasParam(PARAM_IDS.BROW_L_ANGLE) || this.hasParam(PARAM_IDS.BROW_R_ANGLE);
        this.capabilities.hasEyeSmile = this.hasParam(PARAM_IDS.EYE_L_SMILE) || this.hasParam(PARAM_IDS.EYE_R_SMILE);
    }

    /**
     * Check if a specific parameter exists
     * @param {string} paramId 
     * @returns {boolean}
     */
    hasParam(paramId) {
        return this.availableParams.has(paramId);
    }

    /**
     * Check if a specific expression exists
     * @param {string} expName 
     * @returns {boolean}
     */
    hasExpression(expName) {
        if (!expName) return false;
        const searchName = expName.toLowerCase().replace('.exp3.json', '');
        return this.capabilities.expressions.some(e => e.toLowerCase() === searchName);
    }

    /**
     * Get the current capability object
     * @returns {Object}
     */
    getCapabilities() {
        return this.capabilities;
    }

    /**
     * Clear all discovered capabilities
     */
    reset() {
        this.capabilities = {
            hasBlink: false,
            hasMouth: false,
            hasHeadAngle: false,
            hasBodyAngle: false,
            hasPhysics: false,
            hasEyeBallXY: false,
            hasAngleZ: false,
            hasBodyAngleX: false,
            hasBreath: false,
            hasCheek: false,
            hasBrowAngle: false,
            hasEyeSmile: false,
            modelFamily: 'generic',
            expressions: [],
            motionGroups: {}
        };
        this.availableParams.clear();
    }
}
