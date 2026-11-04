import type { BaseMapConfig, ClassificationLevel, ModelSummary } from "@viewer/shared/model";
import type { Schemas } from "./index";

/**
 * The app's own types and the published API must describe the same objects. If either side
 * changes without the other, these lines stop compiling (checked by `typecheck`).
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const yes = <T extends true>(_: T) => undefined;

yes<Same<ModelSummary, Schemas["ModelSummary"]>>(true);
yes<Same<ClassificationLevel, Schemas["Classification"]>>(true);
yes<Same<BaseMapConfig, Schemas["BaseMapConfig"]>>(true);
