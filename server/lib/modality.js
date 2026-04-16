const MODES = ['attention', 'cognition', 'reasoner']
const RANK = { attention: 0, cognition: 1, reasoner: 2 }

export class Modality {
  constructor(config) {
    if (config?.attention?.length && config?.cognition?.length) {
      this._tiers = {
        attention: config.attention,
        cognition: config.cognition,
        reasoner: config?.reasoner?.length ? config.reasoner : null,
      }
      this._mode = 'attention'
      this._isModal = true
    } else {
      this._tiers = null
      this._mode = null
      this._isModal = false
    }
  }

  get isModal() { return this._isModal }
  get mode() { return this._mode }

  get model() {
    if (!this._isModal) return null
    return this._tiers[this._mode]?.[0] || null
  }

  get attentionModel() {
    return this._tiers?.attention?.[0] || null
  }

  get fallbackModels() {
    if (!this._isModal) return []
    return this._tiers[this._mode]?.slice(1) || []
  }

  hasReasoner() {
    return !!this._tiers?.reasoner
  }

  // Default target for stepUp is 'cognition' — implicit callers (floor
  // control, backchannel) bring the agent into its full voice but don't
  // auto-escalate to reasoner. The step_up tool picks a specific target
  // based on current mode.
  stepUp(reason, target = 'cognition') {
    const previous = this._mode
    if (!this._isModal) return { previous, current: previous, changed: false }
    if (!MODES.includes(target)) return { previous, current: previous, changed: false }
    if (target === 'reasoner' && !this.hasReasoner()) {
      return { previous, current: previous, changed: false }
    }
    if (RANK[target] <= RANK[previous]) {
      return { previous, current: previous, changed: false }
    }
    this._mode = target
    return { previous, current: target, changed: true }
  }

  // Default target for stepDown is 'attention' — the resting state.
  // A caller (or the step_down tool) can pass a specific target to go
  // only part of the way (e.g. reasoner → cognition).
  stepDown(reason, target = 'attention') {
    const previous = this._mode
    if (!this._isModal) return { previous, current: previous, changed: false }
    if (!MODES.includes(target)) return { previous, current: previous, changed: false }
    if (RANK[target] >= RANK[previous]) {
      return { previous, current: previous, changed: false }
    }
    this._mode = target
    return { previous, current: target, changed: true }
  }

  toolDefinitions() {
    if (!this._isModal) return []
    const tools = []

    const canStepUp =
      this._mode === 'attention' ||
      (this._mode === 'cognition' && this.hasReasoner())
    if (canStepUp) {
      const nextUp = this._mode === 'attention' ? 'cognition' : 'reasoner'
      tools.push({
        name: 'step_up',
        description:
          this._mode === 'attention'
            ? 'Shift from attention mode to cognition mode. Call this when you are being directly addressed, need to engage substantively, or the moment calls for your full voice. This re-runs the current turn with a more capable model.'
            : 'Shift from cognition mode to reasoner mode. Call this when a problem needs extended multi-step analysis — complex planning, subtle synthesis, hard diagnosis. This re-runs the current turn with the reasoning model, so use sparingly; reasoner turns are the most expensive.',
        input_schema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: `Why you are shifting to ${nextUp} mode.` },
          },
          required: ['reason'],
        },
      })
    }

    const canStepDown = this._mode === 'cognition' || this._mode === 'reasoner'
    if (canStepDown) {
      const targets = this._mode === 'reasoner' ? ['cognition', 'attention'] : ['attention']
      tools.push({
        name: 'step_down',
        description:
          this._mode === 'reasoner'
            ? 'Shift down from reasoner mode. Default drops you back to attention (resting state). Pass target_layer: "cognition" to hold your full voice without the reasoner\'s cost. Takes effect on the next turn.'
            : 'Shift from cognition mode back to attention mode. Call this when the conversation has gone quiet or monitoring is sufficient. Takes effect on the next turn.',
        input_schema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why you are shifting down.' },
            target_layer: {
              type: 'string',
              enum: targets,
              description: 'Optional. Which gear to drop to. Defaults to attention (resting state).',
            },
          },
          required: ['reason'],
        },
      })
    }

    return tools
  }

  executeTool(name, input) {
    if (name === 'step_up') {
      // The tool advances exactly one gear from current.
      const target = this._mode === 'attention' ? 'cognition' : 'reasoner'
      const { previous, current, changed } = this.stepUp(input.reason, target)
      return {
        output: changed
          ? `Shifted from ${previous} to ${current}. Reason: ${input.reason}`
          : `Already in ${current} mode.`,
        _stepUp: changed,
      }
    }

    if (name === 'step_down') {
      const target = input.target_layer || 'attention'
      const { previous, current, changed } = this.stepDown(input.reason, target)
      return {
        output: changed
          ? `Shifted from ${previous} to ${current}. Reason: ${input.reason}`
          : `Already in ${current} mode.`,
      }
    }

    return null
  }
}
