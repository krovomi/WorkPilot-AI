import { CircleCheck, CircleX, RotateCcw } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { OnboardingQuizQuestion } from "../../../preload/api/modules/onboarding-agent-api";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { CategoryBadge, DifficultyBadge, EmptyState } from "./shared";

function QuestionCard({
	question,
	index,
	chosen,
	onAnswer,
}: {
	readonly question: OnboardingQuizQuestion;
	readonly index: number;
	readonly chosen: number | undefined;
	readonly onAnswer: (choice: number) => void;
}): React.ReactElement {
	const { t } = useTranslation("onboardingAgent");
	const hasAnswered = chosen !== undefined;

	return (
		<div className="border rounded-md p-3 space-y-2 bg-card">
			<div className="flex items-start justify-between gap-3">
				<p className="font-medium text-sm">
					{index + 1}. {question.question}
				</p>
				<div className="flex gap-1 shrink-0">
					<CategoryBadge
						category={question.category}
						label={t(`quizCategories.${question.category}`)}
					/>
					<DifficultyBadge
						difficulty={question.difficulty}
						label={t(`difficulty.${question.difficulty}`)}
					/>
				</div>
			</div>
			<div className="space-y-1">
				{question.choices.map((choice, choiceIdx) => {
					const isCorrect = choiceIdx === question.correct_index;
					const isChosen = chosen === choiceIdx;
					return (
						<button
							type="button"
							key={choice}
							onClick={() => !hasAnswered && onAnswer(choiceIdx)}
							disabled={hasAnswered}
							className={`w-full text-left px-3 py-2 rounded-md border text-sm flex items-center gap-2 ${
								hasAnswered && isCorrect
									? "bg-green-500/10 border-green-500/50"
									: hasAnswered && isChosen && !isCorrect
										? "bg-red-500/10 border-red-500/50"
										: "hover:bg-accent"
							}`}
						>
							{hasAnswered && isCorrect && (
								<CircleCheck className="w-4 h-4 text-green-600 shrink-0" />
							)}
							{hasAnswered && isChosen && !isCorrect && (
								<CircleX className="w-4 h-4 text-red-600 shrink-0" />
							)}
							<span className="break-all">{choice}</span>
						</button>
					);
				})}
			</div>
			{hasAnswered && question.rationale && (
				<p className="text-xs text-muted-foreground italic">
					{question.rationale}
				</p>
			)}
		</div>
	);
}

export function QuizPanel(): React.ReactElement | null {
	const { t } = useTranslation("onboardingAgent");
	const pkg = useOnboardingAgentStore((s) => s.pkg);
	const answers = useOnboardingAgentStore((s) => s.quizAnswers);
	const answer = useOnboardingAgentStore((s) => s.answerQuiz);
	const resetQuiz = useOnboardingAgentStore((s) => s.resetQuiz);
	const [filter, setFilter] = useState<string>("all");

	if (!pkg) return null;
	if (pkg.quiz.length === 0) {
		return <EmptyState message={t("emptyQuiz")} />;
	}

	const categories = Array.from(new Set(pkg.quiz.map((q) => q.category)));
	const score = Object.entries(answers).filter(
		([qIdx, chosen]) => pkg.quiz[Number(qIdx)]?.correct_index === chosen,
	).length;
	const answered = Object.keys(answers).length;
	const progress = Math.round((answered / pkg.quiz.length) * 100);

	// Indexes are the store's keys, so filtering must keep them, not renumber.
	const visible = pkg.quiz
		.map((question, index) => ({ question, index }))
		.filter(({ question }) => filter === "all" || question.category === filter);

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm">
						{t("quizScore", {
							score,
							answered,
							total: pkg.quiz.length,
						})}
					</p>
					<Button
						size="sm"
						variant="outline"
						onClick={resetQuiz}
						disabled={answered === 0}
					>
						<RotateCcw className="w-4 h-4 mr-1" />
						{t("actions.retryQuiz")}
					</Button>
				</div>
				<Progress value={progress} />
			</div>

			<div className="flex flex-wrap gap-1.5">
				<button
					type="button"
					onClick={() => setFilter("all")}
					className={`px-2 py-0.5 rounded-md text-xs border ${
						filter === "all" ? "bg-accent" : "hover:bg-accent/50"
					}`}
				>
					{t("filters.all", { count: pkg.quiz.length })}
				</button>
				{categories.map((category) => (
					<button
						type="button"
						key={category}
						onClick={() => setFilter(category)}
						className={`px-2 py-0.5 rounded-md text-xs border ${
							filter === category ? "bg-accent" : "hover:bg-accent/50"
						}`}
					>
						{t(`quizCategories.${category}`)}
					</button>
				))}
			</div>

			{answered === pkg.quiz.length && (
				<div className="border rounded-md p-3 bg-card text-sm">
					{t("quizComplete", { score, total: pkg.quiz.length })}
				</div>
			)}

			{visible.map(({ question, index }) => (
				<QuestionCard
					key={question.question}
					question={question}
					index={index}
					chosen={answers[index]}
					onAnswer={(choice) => answer(index, choice)}
				/>
			))}
		</div>
	);
}
