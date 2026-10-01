import type { IndexedSubtitleModel, Token } from '@project/common';
import type { DictionaryPlaybackConfig, DictionaryPlaybackFeature } from '@project/common/settings';
import { dictionaryPlaybackFeatureEnabled } from '@project/common/settings';
import { HAS_LETTER_REGEX } from '@project/common/util';

type TokenizedText = Pick<IndexedSubtitleModel, 'text' | 'tokenization'>;

const wordTokens = (subtitle: TokenizedText): Token[] =>
    subtitle.tokenization?.tokens.filter((token) => HAS_LETTER_REGEX.test(subtitle.text.slice(...token.pos))) ?? [];

/** Evaluated while a playback plan is built; status counts are independent for each status and state. */
export function matchingPlaybackTokens(
    subtitle: TokenizedText,
    config: DictionaryPlaybackConfig,
    feature: DictionaryPlaybackFeature
): Token[] {
    if (!dictionaryPlaybackFeatureEnabled(config, feature)) return [];
    return matchingTokens(wordTokens(subtitle), config, feature);
}

function matchingTokens(
    tokens: readonly Token[],
    config: DictionaryPlaybackConfig,
    feature: DictionaryPlaybackFeature
): Token[] {
    const rule = config.rules[feature];
    const statusCounts = new Map<number, number>();
    const stateCounts = new Map<number, number>();
    if (rule.maxWords) {
        for (const token of tokens) {
            if (token.status != null) statusCounts.set(token.status, (statusCounts.get(token.status) ?? 0) + 1);
            for (const state of new Set(token.states)) stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
        }
    }
    return tokens.filter((token) => {
        if (rule.maxFrequency > 0 && (token.frequency ?? 1) > rule.maxFrequency) return false;
        const statusMatches =
            token.status != null &&
            config.onStatuses[token.status]?.[feature] &&
            (!rule.maxWords || (statusCounts.get(token.status) ?? 0) <= rule.maxWords);
        const stateMatches = token.states.some(
            (state) =>
                config.onStates[state]?.[feature] && (!rule.maxWords || (stateCounts.get(state) ?? 0) <= rule.maxWords)
        );
        return Boolean(statusMatches || stateMatches);
    });
}

/** Uses the same token matches for individual-word hiding and the whole-subtitle threshold. */
export function subtitleWordVisibility(
    subtitle: TokenizedText,
    config: DictionaryPlaybackConfig
): { readonly hiddenTokens: ReadonlySet<Token>; readonly hideWholeSubtitle: boolean } {
    if (!dictionaryPlaybackFeatureEnabled(config, 'wordVisibility')) {
        return { hiddenTokens: new Set(), hideWholeSubtitle: false };
    }
    const tokens = wordTokens(subtitle);
    const matching = matchingTokens(tokens, config, 'wordVisibility');
    const shownTokens = new Set(matching);
    const hiddenTokens = new Set(tokens.filter((token) => !shownTokens.has(token)));
    return {
        hiddenTokens,
        hideWholeSubtitle: meetsWholeVisibilityThreshold(
            subtitle.text,
            tokens,
            tokens.length - matching.length,
            config.rules.wordVisibility.wholeSubtitleMatchThreshold
        ),
    };
}

function meetsWholeVisibilityThreshold(
    text: string,
    tokens: readonly Token[],
    hiddenCount: number,
    threshold: number
): boolean {
    if (!hiddenCount) return false;

    // Letter-bearing text outside tokenization remains visible, while punctuation does not count.
    const covered = new Uint8Array(text.length);
    for (const token of tokens) for (let i = token.pos[0]; i < token.pos[1]; i++) covered[i] = 1;
    let unmatchedUntokenizedWords = 0;
    let inUntokenizedWord = false;
    for (let offset = 0; offset < text.length; ) {
        const character = String.fromCodePoint(text.codePointAt(offset)!);
        const untokenizedLetter = HAS_LETTER_REGEX.test(character) && !covered[offset];
        if (untokenizedLetter && !inUntokenizedWord) unmatchedUntokenizedWords++;
        inUntokenizedWord = untokenizedLetter;
        offset += character.length;
    }

    return hiddenCount / (tokens.length + unmatchedUntokenizedWords) >= threshold;
}
