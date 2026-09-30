/**
 * Ambient types for `@3d-dice/dice-box` (v1.1.4). The package ships no
 * TypeScript declarations; this mirrors the public API the dice engine hook
 * consumes (constructor config, init/roll/clear lifecycle, roll responses).
 * Kept local to the dice feature so the dependency stays swappable.
 */
declare module '@3d-dice/dice-box' {
  export interface DiceBoxRollDie {
    value: number;
    sides: number | string;
    groupId?: number;
    rollId?: number | string;
    theme?: string;
    themeColor?: string;
  }

  export interface DiceBoxRollGroup {
    value: number;
    qty: number;
    sides?: number | string;
    modifier?: number;
    rolls: DiceBoxRollDie[];
  }

  export interface DiceBoxConfig {
    id?: string;
    container?: string | null;
    assetPath?: string;
    origin?: string;
    scale?: number;
    theme?: string;
    themeColor?: string;
    enableShadows?: boolean;
    shadowTransparency?: number;
    lightIntensity?: number;
    delay?: number;
    offscreen?: boolean;
    gravity?: number;
    mass?: number;
    friction?: number;
    restitution?: number;
    angularDamping?: number;
    linearDamping?: number;
    spinForce?: number;
    throwForce?: number;
    startingHeight?: number;
    settleTimeout?: number;
    suspendSimulation?: boolean;
    onRollComplete?: (results: DiceBoxRollGroup[]) => void;
    onDieComplete?: (die: DiceBoxRollDie) => void;
  }

  export default class DiceBox {
    constructor(config?: DiceBoxConfig);
    canvas: HTMLCanvasElement;
    config: DiceBoxConfig;
    init(): Promise<this>;
    roll(
      notation: string | Record<string, unknown> | (string | Record<string, unknown>)[],
      options?: { theme?: string; themeColor?: string; newStartPoint?: boolean },
    ): Promise<DiceBoxRollDie[]>;
    clear(): void;
    hide(className?: string): this;
    show(): this;
    getRollResults(): DiceBoxRollGroup[];
    updateConfig(config: Partial<DiceBoxConfig>): void;
  }
}
