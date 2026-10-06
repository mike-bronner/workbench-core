// The type contract of workbench-core's hooks module: the values it keeps in
// $.state for the session. `claude plugin validate` holds every $.state key the
// module names to this file.

// One main-loop API request: the model that answered, and its cost in US
// dollars. usd is null when that model has no price.
export type RequestCost = {
  model: string
  usd: number | null
}

// The request meter's figures: turns completed since session start, the
// session's first API request, and its latest. first never moves once set.
export type MeterState = {
  turns: number
  first: RequestCost | null
  last: RequestCost | null
}

declare module 'claude-code' {
  interface PluginState {
    'workbench-core': {
      meter: MeterState
      // Whether a person opened the current turn, so the question rule applies.
      turnAttended: boolean
      // Whether the question rule already re-prompted in the current turn.
      reprompted: boolean
    }
  }
}
