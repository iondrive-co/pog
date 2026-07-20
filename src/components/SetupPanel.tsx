import type { GameOption, GameSpec, OptionValues } from "../dsl.js";
import type { MatchConfig, SeatConfig, SeatKind } from "../config.js";
import { defaultSeat, isAutoSeatName } from "../config.js";
import { STR, fmt } from "../strings.js";
import type { ModelChoice } from "../webllm/index.js";

const S = STR.setupPanel;

/**
 * The seat picker's non-model values. "@" keeps them out of the model-base
 * namespace (WebLLM ids never start with one).
 */
const HUMAN = "@human";
const RULE_BASED = "@rules";

interface BrainOption {
  value: string;
  label: string;
  /** Present but unpickable — a model that hasn't been loaded yet. */
  disabled?: boolean;
}

function SeatEditor(props: {
  index: number;
  seat: SeatConfig;
  onName: (name: string) => void;
  brains: BrainOption[];
  brainValue: string;
  onBrain: (value: string) => void;
  onRemove?: () => void;
  roleName?: string;
  description?: string;
}) {
  const { index, seat, onName, brains, brainValue, onBrain, onRemove, roleName, description } = props;
  return (
    <div className="player-editor">
      <h3>
        {seat.kind === "human" ? S.badgeHuman : S.badgeBot} {fmt(S.seatHeading, { n: index + 1 })}
        {roleName ? fmt(S.seatHeadingRoleSuffix, { role: roleName }) : ""}
        {onRemove && (
          <>
            {" "}
            <button className="stop" onClick={onRemove}>
              {S.removeSeatButton}
            </button>
          </>
        )}
      </h3>
      <label>
        {S.nameLabel}
        <input value={seat.name} onChange={(e) => onName(e.target.value)} maxLength={20} />
      </label>
      <label>
        {S.playedByLabel}
        <select value={brainValue} onChange={(e) => onBrain(e.target.value)}>
          {brains.map((b) => (
            <option key={b.value} value={b.value} disabled={b.disabled}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      {description && <p className="muted small seat-traits">{description}</p>}
    </div>
  );
}

function OptionInput(props: {
  option: GameOption;
  values: OptionValues;
  onChange: (values: OptionValues) => void;
}) {
  const { option, values, onChange } = props;
  return (
    <label>
      {option.label}
      <input
        type="number"
        min={option.min}
        max={option.max}
        value={Number(values[option.key] ?? option.default)}
        onChange={(e) =>
          onChange({
            ...values,
            [option.key]: Math.max(option.min, Math.min(option.max, Number(e.target.value) || option.min)),
          })
        }
      />
    </label>
  );
}

export interface SetupPanelProps {
  /** The game being set up — a DSL `GameSpec`. */
  game: GameSpec<never> | GameSpec<unknown>;
  config: MatchConfig;
  setConfig: (c: MatchConfig) => void;
  /**
   * The models a bot seat may be assigned (label + `base` to store on the
   * seat). Pass an empty list when models aren't on offer (a host with its own
   * agent backend) — seats then only offer human and, if the game has it,
   * rule-based.
   */
  models: ModelChoice[];
  /** The model family a seat plays when it hasn't named one. */
  defaultModel: string;
  /**
   * The model_ids currently loaded. Models not in here are listed but not
   * selectable — load them (in the panel above) to hand them a seat.
   */
  loadedIds: string[];
  canStart: boolean;
  /** True when start is blocked because some seat's model isn't loaded yet. */
  needsModel: boolean;
  onStart: () => void;
}

/**
 * Match setup for one DSL game: its declared option knobs and one editor per
 * seat — a name, plus what plays it: you (the human at this screen), the
 * game's built-in rule-based strategy (when the game file authors one), or any
 * *loaded* model. Seats mix freely; with no human seat the match simply plays
 * itself out (spectate).
 */
export function SetupPanel(props: SetupPanelProps) {
  const { config, setConfig, models, defaultModel, loadedIds, canStart, needsModel, onStart } = props;
  const spec = props.game as GameSpec<unknown>;

  const setName = (i: number) => (name: string) => {
    const seats = [...config.seats];
    seats[i] = { ...seats[i], name };
    setConfig({ ...config, seats });
  };

  // What plays a seat: the human, the rule-based strategy, or a loaded model.
  const botAvailable = spec.bot !== undefined;
  const brains: BrainOption[] = [
    { value: HUMAN, label: S.humanOption },
    ...(botAvailable ? [{ value: RULE_BASED, label: S.ruleBasedOption }] : []),
    ...models.map((m) => ({
      value: m.base,
      label:
        fmt(S.modelOption, { model: m.label, size: (m.vramMB / 1024).toFixed(1) }) +
        (loadedIds.includes(m.id) ? "" : S.modelOptionUnloadedSuffix),
      disabled: !loadedIds.includes(m.id),
    })),
  ];
  const brainValue = (seat: SeatConfig): string =>
    seat.kind === "human" ? HUMAN : seat.kind === "rules" ? RULE_BASED : seat.model ?? defaultModel;

  const setBrain = (i: number) => (value: string) => {
    const seats = [...config.seats];
    const prev = seats[i];
    const kind: SeatKind = value === HUMAN ? "human" : value === RULE_BASED ? "rules" : "llm";
    // A still-default name follows the kind ("Player 3" ↔ "Bot 3"); an edited
    // or game-authored name stays put.
    const name = isAutoSeatName(prev.name, i) ? defaultSeat(i, kind).name : prev.name;
    seats[i] = { kind, name, model: kind === "llm" ? value : undefined };
    setConfig({ ...config, seats });
  };

  const removeSeat = (i: number) => () =>
    setConfig({ ...config, seats: config.seats.filter((_, j) => j !== i) });

  const addSeat = () =>
    setConfig({
      ...config,
      seats: [...config.seats, defaultSeat(config.seats.length, botAvailable ? "rules" : "llm")],
    });

  const spectating = config.seats.every((s) => s.kind !== "human");
  const setupNote = spec.view.setup?.(config.options);

  return (
    <section className="card">
      <div className="card-title">
        <h2>{fmt(S.title, { "game name": spec.name })}</h2>
      </div>
      <div className="row">
        {(spec.options ?? []).map((opt) => (
          <OptionInput
            key={opt.key}
            option={opt}
            values={config.options}
            onChange={(options) => setConfig({ ...config, options })}
          />
        ))}
      </div>
      <p className="muted">{spec.blurb}</p>
      {setupNote && <p className="muted small">{setupNote}</p>}
      <div className="players-row">
        {config.seats.map((seat, i) => (
          <SeatEditor
            key={i}
            index={i}
            seat={seat}
            onName={setName(i)}
            brains={brains}
            brainValue={brainValue(seat)}
            onBrain={setBrain(i)}
            onRemove={config.seats.length > spec.seats.min ? removeSeat(i) : undefined}
            roleName={spec.seats.roleNames?.[i]}
            description={spec.seats.descriptions?.[i]}
          />
        ))}
      </div>
      {config.seats.length < spec.seats.max && (
        <div className="row">
          <button onClick={addSeat}>{S.addPlayerButton}</button>
        </div>
      )}
      <div className="row">
        <button className="primary big" onClick={onStart} disabled={!canStart}>
          {S.startButton}
        </button>
        {spectating && canStart && <span className="muted small">{S.spectatingNote}</span>}
        {!canStart && needsModel && <span className="muted small">{S.needsModelNote}</span>}
      </div>
    </section>
  );
}
