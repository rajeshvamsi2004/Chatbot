import React, { useState, useRef, useEffect } from 'react';
import './Quiz.css';

const QUIZ_LEVELS = ['Basic', 'Intermediate', 'Hard'];
const PASSING_SCORE = 3;

const Quiz = () => {
  const [view, setView] = useState('setup');
  const [sourceText, setSourceText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  const [currentLevel, setCurrentLevel] = useState(QUIZ_LEVELS[0]);
  const [quizData, setQuizData] = useState([]);
  const [userAnswers, setUserAnswers] = useState({});
  const [totalScore, setTotalScore] = useState(0);
  const [allResults, setAllResults] = useState({});
  const [lastLevelResult, setLastLevelResult] = useState(null);

  const [recommendationData, setRecommendationData] = useState(null);
  const [isFetchingRecommendation, setIsFetchingRecommendation] = useState(false);
  const quizContainerRef = useRef(null);

  useEffect(() => {
    if (view === 'levelComplete' && lastLevelResult && lastLevelResult.score < PASSING_SCORE) {
      const fetchRecommendations = async () => {
        setIsFetchingRecommendation(true);
        setRecommendationData(null);
        try {
          const levelResult = allResults[currentLevel];
          const incorrectQuestions = levelResult.quizData.filter((_, index) =>
            levelResult.userAnswers[index] !== levelResult.quizData[index].correctAnswerIndex
          );

          const response = await fetch('http://localhost:5005/generate-recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: sourceText,
              level: currentLevel,
              incorrectQuestions
            }),
          });

          if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Server returned an error.');
          }

          const data = await response.json();
          setRecommendationData(data);

        } catch (error) {
          console.error("--- RECOMMENDATION FETCH FAILED ---", error);
          setRecommendationData({
            message: 'Could not load AI recommendations. This might be an issue with the backend server or the Google AI API key.',
            conceptsToReview: ['Please check your backend server terminal for error messages.'],
            suggestedCourses: []
          });
        } finally {
          setIsFetchingRecommendation(false);
        }
      };
      fetchRecommendations();
    }
  }, [view, lastLevelResult]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && (view === 'quiz' || view === 'levelComplete')) {
        alert("You have exited fullscreen. The quiz will now reset.");
        handleReset();
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [view]);

  const fetchAndStartQuiz = async (level) => {
    setIsLoading(true);
    setQuizData([]);
    try {
      const response = await fetch('http://localhost:5005/generate-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sourceText, level }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setCurrentLevel(level);
      setQuizData(data.quiz);
      setUserAnswers({});
      setView('quiz');
    } catch (error) {
      console.error(`Failed to generate ${level} quiz:`, error);
      alert(`Could not generate the ${level} quiz. Please ensure the backend is running.`);
      setView('setup');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartQuizFlow = async () => {
    if (sourceText.trim() === '') {
      alert('Please paste some text to generate a quiz.');
      return;
    }
    await fetchAndStartQuiz(QUIZ_LEVELS[0]);
  };

  const handleSubmitQuiz = () => {
    let calculatedScore = 0;
    quizData.forEach((question, index) => {
      if (userAnswers[index] === question.correctAnswerIndex) {
        calculatedScore++;
      }
    });

    setTotalScore(prev => prev + calculatedScore);
    setAllResults(prev => ({
      ...prev,
      [currentLevel]: { score: calculatedScore, total: quizData.length, quizData, userAnswers }
    }));
    setLastLevelResult({ score: calculatedScore, total: quizData.length });

    const currentLevelIndex = QUIZ_LEVELS.indexOf(currentLevel);
    const isLastLevel = currentLevelIndex === QUIZ_LEVELS.length - 1;

    if (isLastLevel) {
      setView('results');
    } else {
      setView('levelComplete');
    }
  };

  const handleStartNextLevel = async () => {
    const currentResult = allResults[currentLevel];
    const didPass = currentResult?.score >= PASSING_SCORE;

    if (!didPass) {
      alert(`You need to pass the ${currentLevel} level (score ≥ ${PASSING_SCORE}) to proceed.`);
      return;
    }

    const currentLevelIndex = QUIZ_LEVELS.indexOf(currentLevel);
    const nextLevel = QUIZ_LEVELS[currentLevelIndex + 1];

    if (nextLevel) {
      setRecommendationData(null);
      await fetchAndStartQuiz(nextLevel);
    }
  };

  const handleRetryLevel = () => {
    setUserAnswers({});
    setRecommendationData(null);
    setView('quiz');
  };

  const handleShowFinalResults = () => {
    setView('results');
  };

  const handleAnswerChange = (questionIndex, optionIndex) => {
    setUserAnswers(prev => ({ ...prev, [questionIndex]: optionIndex }));
  };

  const handleReset = () => {
    setView('setup');
    setSourceText('');
    setQuizData([]);
    setUserAnswers({});
    setTotalScore(0);
    setAllResults({});
    setLastLevelResult(null);
    setCurrentLevel(QUIZ_LEVELS[0]);
    setRecommendationData(null);
    setIsFetchingRecommendation(false);
  };

  const renderSetupView = () => (
    <div className="setup-container fade-in">
      <h1>AI-Powered Progressive Quiz</h1>
      <p>Paste text below. You must score at least {PASSING_SCORE} on each level to advance.</p>
      <textarea id="source-text" placeholder="For example, paste a summary of Java, a history article, or a science concept..." value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
      <button onClick={handleStartQuizFlow} disabled={isLoading}> ✨ Start Quiz Challenge </button>
    </div>
  );

  const renderLoadingView = () => (
    <div className="loading-view">
      <div className="loading-spinner"></div>
      <p>Generating your {currentLevel} quiz, please wait...</p>
    </div>
  );

  const renderQuizView = () => (
    <div className="quiz-view fade-in">
      <h2 style={{color: 'black',fontFamily: 'sans-serif',fontSize: '14px'}}>Test Your Knowledge! (Level: {currentLevel})</h2>
      <div className="quiz-scroll-area">
        {quizData.map((q, index) => (
          <div key={index} className="question-block">
            <p className="question-text">{`${index + 1}. ${q.question}`}</p>
            <div className="options-list">
              {q.options.map((option, optionIndex) => (
                <label key={optionIndex} className={`option-label ${userAnswers[index] === optionIndex ? 'selected' : ''}`}>
                  <input type="radio" name={`question-${index}`} checked={userAnswers[index] === optionIndex} onChange={() => handleAnswerChange(index, optionIndex)} />
                  {option}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button className="submit-button" onClick={handleSubmitQuiz}>Submit Answers</button>
    </div>
  );

  const renderLevelCompleteView = () => {
    if (!lastLevelResult) return null;
    const didPass = lastLevelResult.score >= PASSING_SCORE;

    return (
      <div className="level-complete-view fade-in">
        <h2>Level Complete: {currentLevel}</h2>
        <div style={{color: 'black',fontFamily: 'sans-serif', fontSize: '14px'}} className="score-badge">
          You scored <strong>{lastLevelResult.score}</strong> out of <strong>{lastLevelResult.total}</strong>
        </div>

        {didPass ? (
          <>
            <p className="level-complete-message success">Excellent work! You've unlocked the next level.</p>
            <div className="level-complete-actions">
              <button className="submit-button" onClick={handleStartNextLevel}>
                Start '{QUIZ_LEVELS[QUIZ_LEVELS.indexOf(currentLevel) + 1]}' Level
              </button>
              <button className="submit-button try-again-button" onClick={handleRetryLevel}>Try This Level Again</button>
              <button className="reset-button" onClick={handleShowFinalResults}>End Quiz & View Answers</button>
            </div>
          </>
        ) : (
          <div className="recommendation-section">
            <p className="level-complete-message failure">
              You need a score of {PASSING_SCORE} or more to proceed. Here's some feedback to help.
            </p>
            {isFetchingRecommendation && <div className="loading-spinner small"></div>}
            {recommendationData && (
              <div className="recommendation-content fade-in">
                <p className="recommendation-message">{recommendationData.message}</p>
                {recommendationData.conceptsToReview?.length > 0 && (
                  <div className="recommendation-block">
                    <h4>Concepts to Review</h4>
                    <ul>{recommendationData.conceptsToReview.map((concept, i) => <li key={i}>{concept}</li>)}</ul>
                  </div>
                )}
                {recommendationData.suggestedCourses?.length > 0 && (
                  <div className="recommendation-block">
                    <h4>Suggested Learning</h4>
                    <ul>{recommendationData.suggestedCourses.map((course, i) => <li key={i}>{course}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
            <div className="level-complete-actions">
              <button className="submit-button try-again-button" onClick={handleRetryLevel}>Try This Level Again</button>
              <button className="reset-button" onClick={handleShowFinalResults}>End Quiz & View Answers</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderResultsView = () => (
    <div className="results-view fade-in">
      <h2>Quiz Challenge Results</h2>
      <div className="score-badge">
        Your final total score is <strong>{totalScore}</strong> out of <strong>{Object.values(allResults).reduce((acc, level) => acc + level.total, 0)}</strong>
      </div>
      <div className="results-scroll-area">
        {QUIZ_LEVELS.map(level => {
          const result = allResults[level];
          if (!result) return null;
          return (
            <div key={level} className="level-result-block">
              <h3>{level} Level Results: {result.score} / {result.total}</h3>
              {result.quizData.map((q, index) => {
                const userAnswer = result.userAnswers[index];
                const isCorrect = userAnswer === q.correctAnswerIndex;
                return (
                  <div key={index} className={`result-item ${isCorrect ? 'correct' : 'incorrect'}`}>
                    <p className="result-question-text"><strong>{index + 1}. {q.question}</strong></p>
                    {!isCorrect && <p>Your answer: {q.options[userAnswer] || "No answer"}</p>}
                    <p className="result-explanation"><strong>💡 Correct Answer:</strong> {q.options[q.correctAnswerIndex]}</p>
                    <p className="result-explanation"><strong>💬 Explanation:</strong> {q.explanation}</p>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <button className="submit-button" onClick={handleReset}>Create a New Quiz</button>
    </div>
  );

  const renderContent = () => {
    if (isLoading) return renderLoadingView();
    switch (view) {
      case 'setup': return renderSetupView();
      case 'quiz': return renderQuizView();
      case 'levelComplete': return renderLevelCompleteView();
      case 'results': return renderResultsView();
      default: return renderSetupView();
    }
  };

  return (
    <div ref={quizContainerRef} className="quiz-app-container">
      {renderContent()}
    </div>
  );
};

export default Quiz;
