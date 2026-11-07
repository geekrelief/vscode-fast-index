'use strict';
/** Query workload: realistic Unreal Engine searches, by category. */
module.exports = [
    // long identifiers: the case trigrams are supposed to handle well
    { cat: 'identifier', q: 'GetActorLocation' },
    { cat: 'identifier', q: 'FVector::ZeroVector' },
    { cat: 'identifier', q: 'bUseControllerRotationYaw' },
    { cat: 'identifier', q: 'LineTraceSingleByChannel' },
    { cat: 'identifier', q: 'CreateDefaultSubobject' },
    { cat: 'identifier', q: 'TWeakObjectPtr' },
    { cat: 'identifier', q: 'GetTimerManager' },
    { cat: 'identifier', q: 'FString::Printf' },

    // short, heavy-tailed words
    { cat: 'word', q: 'draw' },
    { cat: 'word', q: 'mesh' },
    { cat: 'word', q: 'actor' },
    { cat: 'word', q: 'cast' },
    { cat: 'word', q: 'text' },
    { cat: 'word', q: 'world' },
    { cat: 'word', q: 'void' },

    // multi-word phrases: words are common, the phrase is not
    { cat: 'phrase', q: 'for (int' },
    { cat: 'phrase', q: 'return false' },
    { cat: 'phrase', q: 'return nullptr;' },
    { cat: 'phrase', q: 'static_cast<' },
    { cat: 'phrase', q: 'const FVector&' },
    { cat: 'phrase', q: 'namespace UE' },
    { cat: 'phrase', q: ') const' },
    { cat: 'phrase', q: 'if (' },

    // punctuation / macros: where a word-split index has no terms at all
    { cat: 'symbol', q: 'UPROPERTY(EditAnywhere' },
    { cat: 'symbol', q: 'GENERATED_BODY()' },
    { cat: 'symbol', q: '#include "' },
    { cat: 'symbol', q: 'TArray<' },
    { cat: 'symbol', q: 'UE_LOG(LogTemp' },
    { cat: 'symbol', q: 'TEXT(' },
    { cat: 'symbol', q: '->' },
    { cat: 'symbol', q: '::' },
    { cat: 'symbol', q: '//' },
    { cat: 'symbol', q: '&&' },
    { cat: 'symbol', q: '}}' },
    { cat: 'symbol', q: '##' },
    { cat: 'symbol', q: '###' },
    { cat: 'symbol', q: '})' },
    { cat: 'symbol', q: 'FVector>' },

    // filenames, which the index answers from the name table
    { cat: 'filename', q: 'Actor.h' },
    { cat: 'filename', q: 'GameMode.cpp' },
    { cat: 'filename', q: 'CoreMinimal.h' },

    // regex (the index cannot prune these at all)
    { cat: 'regex', q: 'LogTemp.*Warning' },
    { cat: 'regex', q: 'UCLASS\\(.*\\)' },
];
