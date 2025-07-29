import React, { useState, useRef, useEffect } from 'react';
import './Aistudio.css';

// ===================================================================================
// ▼▼▼ NEW COMPONENT: To display results from OpenAlex and CORE ▼▼▼
// ===================================================================================
const ResearchModeResults = ({ data }) => {
    // Helper function to create a clickable DOI link
    const renderDoiLink = (doi) => {
        if (!doi) return null;
        // The DOI might already be a full URL
        const doiUrl = doi.startsWith('http') ? doi : `https://doi.org/${doi}`;
        return <a href={doiUrl} target="_blank" rel="noopener noreferrer" className="source-link">View Article</a>;
    }

    return (
        <div className="research-mode-results">
            {data.openAlex && data.openAlex.length > 0 && (
                <div className="sources-container">
                    <h3 className="sources-title">OpenAlex Results</h3>
                    <ul className="sources-list">
                        {data.openAlex.map((item, index) => (
                            <li key={`oa-${index}`} className="source-item">
                                <p className="source-title">{item.title}</p>
                                <p className="source-snippet">
                                    {item.doi && renderDoiLink(item.doi)}
                                </p>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {data.core && data.core.length > 0 && (
                <div className="sources-container">
                    <h3 className="sources-title">CORE Results</h3>
                    <ul className="sources-list">
                        {data.core.map((item, index) => (
                            <li key={`core-${index}`} className="source-item">
                                <p className="source-title">{item.title}</p>
                                <p className="source-snippet">
                                    {item.year && `Published: ${item.year}`}
                                </p>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {(!data.openAlex || data.openAlex.length === 0) && (!data.core || data.core.length === 0) && (
                <p>No academic results were found for this query.</p>
            )}
        </div>
    );
};


// ===================================================================================
// ▼▼▼ Main Aistudio Component: Contains all the logic and state ▼▼▼
// ===================================================================================
const Chatbot = ({text}) => {
    // --- Existing State ---
    const [history, setHistory] = useState([]);
    const [files, setFiles] = useState([]);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const fileInputRef = useRef(null);
    const [isLoading, setIsLoading] = useState(false);
    const [analysisData, setAnalysisData] = useState(null);
    const [isPreviewMode, setIsPreviewMode] = useState(false);
    const [isPodcastModalOpen, setIsPodcastModalOpen] = useState(false);
    const [isQuizModalOpen, setIsQuizModalOpen] = useState(false);
    const [isResearchMode, setIsResearchMode] = useState(false);
    // ★★★ LIFTED STATE: Query state is now managed here ★★★
    const [query, setQuery] = useState('');


    useEffect(() => {
        const fetchHistory = async () => { 
            try { 
                const response = await fetch('/api/history'); 
                if (!response.ok) throw new Error(`Network response was not ok`); 
                const data = await response.json(); 
                if (Array.isArray(data)) setHistory(data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))); 
            } catch (error) { 
                console.error("Failed to fetch history:", error); 
            } 
        };
        fetchHistory();
    }, []);

    // ★★★ UPDATED: handleNewChat now also clears the query ★★★
    const handleNewChat = () => {
        setAnalysisData(null);
        setIsPreviewMode(false);
        setIsSidebarOpen(false);
        setQuery(''); // This will clear the input in the search bar
    };

    // --- UPDATED SEARCH SUBMIT LOGIC ---
    const handleSearchSubmit = async (searchQuery) => {
        setIsPreviewMode(false);
        setIsLoading(true);
        setAnalysisData(null);

        if (isResearchMode) {
            // --- LOGIC FOR RESEARCH MODE ---
            try {
                // Fetch from your new Node.js research backend
                const response = await fetch(`http://localhost:5000/search?query=${encodeURIComponent(searchQuery)}`);
                
                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error || 'Failed to fetch from research backend.');
                }
                
                const data = await response.json();
                
                // Set the analysis data with the new format, and a flag to identify it
                setAnalysisData({ 
                    ...data,
                    isResearchResult: true, // This flag helps the UI decide how to render
                    userQuery: searchQuery
                });

            } catch (error) {
                console.error(error);
                setAnalysisData({ error: error.message, userQuery: searchQuery });
            } finally {
                setIsLoading(false);
            }

        } else {
            // --- LOGIC FOR ORIGINAL AI ANALYSIS ---
            
            try {
                const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: searchQuery }) });
                if (!response.ok) { 
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error || 'Failed to fetch analysis'); 
                }
                const data = await response.json();
                setAnalysisData({ ...data, userQuery: searchQuery }); 
                const historyResponse = await fetch('/api/history');
                const updatedHistory = await historyResponse.json();
                if (Array.isArray(updatedHistory)) {
                    setHistory(updatedHistory.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
                }
            } catch (error)
             {
                console.error(error);
                setAnalysisData({ error: error.message, userQuery: searchQuery });
            } finally {
                setIsLoading(false);
            }
        }
    };
    
const handleAnalyzeFile = async (file) => {
    if (!file) {
        console.warn("[handleAnalyzeFile] ❌ No file passed.");
        setAnalysisData({
            error: "I need the document to analyze it.",
            userQuery: "Analysis requested, but no document was selected."
        });
        return;
    }

    setIsSidebarOpen(false);
    setIsPreviewMode(false);
    setIsLoading(true);
    setAnalysisData(null);

    try {
        // Helper function to extract text from PDF using PDF.js
        const extractTextFromPDF = async (file) => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = async function(e) {
                    try {
                        // Load PDF.js if not already loaded
                        if (typeof window.pdfjsLib === 'undefined') {
                            throw new Error('PDF.js library not loaded. Please add the PDF.js script to your HTML.');
                        }

                        const typedarray = new Uint8Array(e.target.result);
                        const pdf = await window.pdfjsLib.getDocument(typedarray).promise;
                        let fullText = '';
                        
                        // Extract text from all pages
                        for (let i = 1; i <= pdf.numPages; i++) {
                            const page = await pdf.getPage(i);
                            const textContent = await page.getTextContent();
                            const pageText = textContent.items.map(item => item.str).join(' ');
                            fullText += `--- Page ${i} ---\n${pageText}\n\n`;
                        }
                        
                        resolve({
                            text: fullText.trim(),
                            pageCount: pdf.numPages
                        });
                    } catch (error) {
                        reject(new Error(`Failed to extract PDF text: ${error.message}`));
                    }
                };
                reader.onerror = () => reject(new Error('Failed to read PDF file'));
                reader.readAsArrayBuffer(file);
            });
        };

        // Helper function to extract text from TXT files
        const extractTextFromTXT = async (file) => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const text = e.target.result;
                    resolve({
                        text: text,
                        pageCount: 1
                    });
                };
                reader.onerror = () => reject(new Error('Failed to read text file'));
                reader.readAsText(file);
            });
        };

        // Extract text based on file type
        let extractedData;
        const fileType = file.type || file.name.toLowerCase().split('.').pop();
        
        if (fileType === 'application/pdf' || fileType === 'pdf') {
            extractedData = await extractTextFromPDF(file);
        } else if (fileType === 'text/plain' || fileType === 'txt') {
            extractedData = await extractTextFromTXT(file);
        } else {
            throw new Error(`Unsupported file type: ${fileType}. Please upload PDF or TXT files only.`);
        }

        const { text, pageCount } = extractedData;

        if (!text || text.trim().length < 10) {
            throw new Error('No readable text found in the document or the document appears to be empty.');
        }

        // Simple text processing for display
        const words = text.split(/\s+/).filter(word => word.length > 0);
        const wordCount = words.length;
        const charCount = text.length;
        const readingTime = Math.ceil(wordCount / 200); // Average reading speed: 200 words/minute
        
        // Create a preview of the content (first 500 characters)
        const textPreview = text.length > 500 ? text.substring(0, 500) + '...' : text;

        // Clean up the extracted text for better readability
        const cleanedText = text
            .replace(/\s+/g, ' ') // Replace multiple spaces with single space
            .replace(/\n+/g, '\n') // Replace multiple newlines with single newline
            .trim();

        // Create a better summary that includes actual content
        const firstSentences = cleanedText.split('.').slice(0, 3).join('.').trim();
        const contentPreview = firstSentences.length > 0 ? firstSentences + '.' : cleanedText.substring(0, 200) + '...';
        
        const summary = `Document Summary: ${contentPreview}\n\nDocument Statistics: ${wordCount.toLocaleString()} words across ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}. Estimated reading time: ${readingTime} ${readingTime === 1 ? 'minute' : 'minutes'}.`;

        // Extract key sections or paragraphs from the content
        const paragraphs = cleanedText.split(/\n\s*\n/).filter(p => p.trim().length > 50);
        const keyContentPoints = paragraphs.slice(0, 5).map((paragraph, index) => 
            `Section ${index + 1}: ${paragraph.trim().substring(0, 150)}${paragraph.length > 150 ? '...' : ''}`
        );

        // Generate key points with actual content
        const keyPoints = [
            `File: ${file.name} (${(file.size / 1024).toFixed(2)} KB, ${pageCount} pages)`,
            `Content Overview: ${wordCount.toLocaleString()} words, ${readingTime} min read`,
            ...keyContentPoints,
            ...(keyContentPoints.length < 3 ? [`Full Content: ${cleanedText.substring(0, 300)}${cleanedText.length > 300 ? '...' : ''}`] : [])
        ];

        // Set the analysis data with extracted content
        setAnalysisData({
            summary: summary,
            key_points: keyPoints,
            userQuery: `Text Extraction: ${file.name}`,
            extracted_text: text, // Full extracted text
            text_preview: textPreview, // Preview for display
            document_stats: {
                fileName: file.name,
                fileSize: file.size,
                wordCount: wordCount,
                charCount: charCount,
                pageCount: pageCount,
                readingTime: readingTime,
                fileType: fileType
            }
        });

        console.log("✅ Text extraction completed successfully");

    } catch (error) {
        console.error('File analysis error:', error);
        setAnalysisData({
            error: error.message || "An error occurred during file text extraction.",
            userQuery: `Text Extraction Failed: ${file?.name || "Unknown File"}`
        });
    } finally {
        setIsLoading(false);
    }
};
const handleFileUpload = (event) => { 
    const uploadedFile = event.target.files[0]; 
    if (uploadedFile) {
        setFiles(prev => {
            if (prev.some(f => f.name === uploadedFile.name)) {
                alert(`A file named "${uploadedFile.name}" has already been uploaded.`);
                return prev;
            }
            return [uploadedFile, ...prev];
        });

        // ✅ Call analyze after upload
        handleAnalyzeFile(uploadedFile);
    }
    event.target.value = null;
};

    const handleDeleteHistoryItem = async (id) => { 
        const originalHistory = [...history];
        setHistory(prev => prev.filter(item => item._id !== id)); 
        try { 
            const response = await fetch(`/api/history/${id}`, { method: 'DELETE' }); 
            if (!response.ok) { throw new Error('Failed to delete on the server.'); }
        } catch (error) { 
            console.error("Failed to delete history item:", error);
            setHistory(originalHistory);
            alert("Could not delete the item. Please try again.");
        } 
    };

    const handleRenameHistoryItem = async (id, newQuery) => { 
        const originalHistory = [...history];
        setHistory(prev => prev.map(item => item._id === id ? { ...item, query: newQuery } : item)); 
        try { 
            const response = await fetch(`/api/history/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: newQuery }) }); 
            if (!response.ok) { throw new Error('Failed to rename on the server.'); }
        } catch (error) { 
            console.error("Failed to rename history item:", error);
            setHistory(originalHistory);
            alert("Could not rename the item. Please try again.");
        } 
    };

    return (
        <div className="layout-container">
            {/* {isLoading && <LoadingOverlay  />} */}
            <Sidebar 
                history={history} 
                files={files} 
                onNewChat={handleNewChat}
                onFileImport={() => fileInputRef.current.click()} 
                isOpen={isSidebarOpen} 
                onClose={() => setIsSidebarOpen(false)} 
                onDeleteItem={handleDeleteHistoryItem} 
                onRenameItem={handleRenameHistoryItem} 
                onAnalyzeFile={handleAnalyzeFile}
            />
            <input type="file" ref={fileInputRef} onChange={handleFileUpload} style={{ display: 'none' }} accept=".pdf,.txt" />
            
            {isPodcastModalOpen && analysisData?.summary && ( <PodcastGenerator topic={analysisData.summary} onClose={() => setIsPodcastModalOpen(false)} /> )}
            
            {isQuizModalOpen && analysisData && (
                <QuizGenerator 
                   sourceText={analysisData.summary} onClose={() => setIsQuizModalOpen(false)}
                />
            )}

            {isPreviewMode && analysisData ? (
                <PrintPreviewPage onExit={() => setIsPreviewMode(false)} analysisData={analysisData} userQuery={analysisData.userQuery || ''} />
            ) : (
                // ★★★ UPDATED: Pass query state and setter down to MainContent ★★★
                <MainContent 
                    onMenuClick={() => setIsSidebarOpen(true)}
                    onSearchSubmit={handleSearchSubmit}
                    isLoading={isLoading}
                    analysisData={analysisData}
                    onEnterPreviewMode={() => setIsPreviewMode(true)}
                    onPlayPodcast={() => setIsPodcastModalOpen(true)}
                    onGenerateQuiz={() => setIsQuizModalOpen(true)} 
                    isResearchMode={isResearchMode}
                    onResearchModeChange={setIsResearchMode}
                    query={query}
                    setQuery={setQuery}
                />
            )}
        </div>
    );
};


// ===================================================================================
// ▼▼▼ MainContent Component: Updated to be a controlled component ▼▼▼
// ===================================================================================
const MainContent = ({ onMenuClick, onSearchSubmit, isLoading, analysisData, onEnterPreviewMode, onGenerateQuiz, onPlayPodcast, isResearchMode, onResearchModeChange, query, setQuery }) => {
    const handleSearch = (e) => { e.preventDefault(); if (!query.trim() || isLoading) return; onSearchSubmit(query); };
    const handleExampleClick = (exampleQuery) => { setQuery(exampleQuery); onSearchSubmit(exampleQuery); };
    const shouldShowWelcomeScreen = !isLoading && !analysisData;
    
    useEffect(() => {
        if (analysisData && analysisData.userQuery) {
            if (!analysisData.userQuery.startsWith('Analysis of:')) {
                setQuery(analysisData.userQuery);
            }
        }
    }, [analysisData, setQuery]);

    return (
        <div className="main-content-area">
            <header className="main-header"><button className="hamburger-menu" onClick={onMenuClick}><HamburgerIcon /></button><h2>Analysis Engine</h2></header>
            <main className="ai-main-content">{shouldShowWelcomeScreen ? <WelcomeScreen onExampleClick={handleExampleClick} /> : <ResultsView userQuery={analysisData?.userQuery || query} isLoading={isLoading} analysisData={analysisData} onSearchSubmit={onSearchSubmit} onEnterPreviewMode={onEnterPreviewMode} onGenerateQuiz={onGenerateQuiz} onPlayPodcast={onPlayPodcast} />}</main>
            
            <footer className="ai-footer">
                {/* The form structure is slightly changed here */}
                <form className="search-bar" onSubmit={handleSearch}>
                    {/* 1. This new wrapper will contain the input and the toggle */}
                    <div className="search-input-wrapper">
                        <input 
                            type="text" 
                            value={query} 
                            onChange={(e) => setQuery(e.target.value)} 
                            placeholder={isResearchMode ? 'Search scholarly articles...' : 'Ask me to analyze anything...'}
                            disabled={isLoading} 
                        />
                        {/* 2. The toggle is moved INSIDE the wrapper, after the input */}
                        <div 
                            className={`research-mode-toggle-bottom ${isResearchMode ? 'active' : ''}`}
                            onClick={() => onResearchModeChange(!isResearchMode)}
                            title="Toggle Research Mode"
                        >
                            <SearchIcon />
                            <span>Research Mode</span>
                        </div>
                    </div>

                    <button type="submit" disabled={!query.trim() || isLoading}>
                        <svg width="24" height="24" viewBox="0 0 24" fill="currentColor"><path d="M2.01 21L23 12L2.01 3L2 10L17 12L2 14L2.01 21Z" /></svg>
                    </button>
                </form>

                <p className="footer-notice">Answers and quizzes are generated by AI from search results and uploaded documents.</p>
            </footer>
        </div>
    );
};

// ===================================================================================
// ▼▼▼ NEW LOADER COMPONENT: Inspired by the provided image ▼▼▼
// ===================================================================================

const ExperimentalThoughtsLoader = () => {
    const loadingMessages = [
        "Searching from duckduckgo...",
        "Synthesizing",
        "Collecting The Web Content",
        "Scraping From The Popular Websites",
        "Analyzing the Content"
    ];

    const [currentIndex, setCurrentIndex] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentIndex(prev => (prev + 1) % loadingMessages.length);
        }, 2000); // Rotate every 2 seconds

        return () => clearInterval(interval);
    }, []);

    return (
        <div className="thoughts-loader-container">
            <div className="thoughts-header">
                <div className="thoughts-left-content">
                    <div className="sparkle-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                            <defs>
                                <linearGradient id="sparkle-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" stopColor="#9b59b6" />
                                    <stop offset="100%" stopColor="#3498db" />
                                </linearGradient>
                            </defs>
                            <path d="M12 0L14.47 9.53L24 12L14.47 14.47L12 24L9.53 14.47L0 12L9.53 9.53L12 0Z" fill="url(#sparkle-gradient)" />
                        </svg>
                    </div>
                    <div className="thoughts-title-text">
                        <strong>Thoughts</strong> <span>(experimental)</span>
                    </div>
                </div>
                <div className="auto-pill">Auto</div>
            </div>

            <div className="thoughts-divider"></div>

            <div className="thinking-indicator">
                <div className="thinking-bar"></div>
            </div>

            <div className="thoughts-loading-message" style={{ marginTop: "12px", textAlign: "center", color: "black", fontFamily: "sans-serif" }}>
                <p>{loadingMessages[currentIndex]}</p>
            </div>
        </div>
    );
};


// ===================================================================================
// ▼▼▼ ResultsView Component: Updated with the new loader ▼▼▼
// ===================================================================================
const ResultsView = ({ userQuery, isLoading, analysisData, onSearchSubmit, onEnterPreviewMode, onGenerateQuiz, onPlayPodcast }) => (
    <div className="results-view">
        <div className="user-prompt"><div className="avatar user-avatar">R</div><p>{userQuery}</p></div>
        <div className="ai-response">
            <div className="avatar ai-avatar"><SearchIcon /></div>
            <div className="response-content">
                {isLoading ? <ExperimentalThoughtsLoader /> : (analysisData && (<>
                    {analysisData.error && <p className="error-message">{analysisData.error}</p>}
                    
                    {/* --- THIS IS THE KEY CONDITIONAL LOGIC --- */}
                    {analysisData.isResearchResult ? (
                        // If it's a research result, show the new component
                        <ResearchModeResults data={analysisData.data} />
                    ) : (
                        // Otherwise, show the original analysis components
                        <>
                            {analysisData.summary && (
                                <>
                                    <ResponseActions onEnterPreviewMode={onEnterPreviewMode} onGenerateQuiz={onGenerateQuiz} onPlayPodcast={onPlayPodcast} />
                                    <SynthesizedAnswer summary={analysisData.summary} keyPoints={analysisData.key_points} />
                                </>
                            )}
                            {analysisData.all_search_results && analysisData.all_search_results.length > 0 && <SourcesList sources={analysisData.all_search_results} />}
                            {analysisData.follow_up_questions && analysisData.follow_up_questions.length > 0 && <FollowUpQuestions questions={analysisData.follow_up_questions} onQuestionClick={onSearchSubmit} />}
                        </>
                    )}
                </>))}
            </div>
        </div>
    </div>
);


// ===================================================================================
// ▼▼▼ ALL OTHER UNCHANGED COMPONENTS AND ICONS ▼▼▼
// ===================================================================================
const QuizGenerator = ({ sourceText, onClose }) => {
    // --- State Management ---
    const [view, setView] = useState('loading'); // loading, quiz, levelComplete, results
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    const QUIZ_LEVELS = ['Basic', 'Intermediate', 'Hard'];
    const PASSING_SCORE = 3; 

    const [currentLevel, setCurrentLevel] = useState(QUIZ_LEVELS[0]);
    const [quizData, setQuizData] = useState([]);
    const [userAnswers, setUserAnswers] = useState({});

    const [totalScore, setTotalScore] = useState(0);
    const [allResults, setAllResults] = useState({});
    const [lastLevelResult, setLastLevelResult] = useState(null);
    
    const [recommendationData, setRecommendationData] = useState(null);
    const [isFetchingRecommendation, setIsFetchingRecommendation] = useState(false);

    const quizModalRef = useRef(null);

    const fetchAndStartQuiz = async (level) => {
        setIsLoading(true);
        setError(null);
        setQuizData([]);
        
        try {
            const response = await fetch('http://localhost:5005/generate-quiz', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: sourceText, level: level }),
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Failed to generate quiz from server.');
            }
            const data = await response.json();
            
            setCurrentLevel(level);
            setQuizData(data.quiz);
            setUserAnswers({});
            setView('quiz');

        } catch (err) {
            console.error(`Failed to generate ${level} quiz:`, err);
            setError(err.message || `Could not generate the ${level} quiz.`);
            setView('error');
        } finally {
            setIsLoading(false);
        }
    };

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
                            incorrectQuestions: incorrectQuestions
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
                        message: 'Could not load AI recommendations. Please check the browser console and backend terminal for errors.',
                        conceptsToReview: ['Is the backend server running?', 'Is the Google AI API key valid and billing enabled?'], 
                        suggestedCourses: [] 
                    });
                } finally {
                    setIsFetchingRecommendation(false);
                }
            };
            fetchRecommendations();
        }
    }, [view, lastLevelResult, allResults, currentLevel, sourceText]);

    useEffect(() => {
        const quizElement = quizModalRef.current;
        if (!quizElement) return;

        const enterFullscreenAndFetch = async () => {
            try {
                await quizElement.requestFullscreen();
            } catch (err) {
                console.warn("Fullscreen request was denied. Continuing in modal view.", err);
            }
            await fetchAndStartQuiz(QUIZ_LEVELS[0]);
        };

        enterFullscreenAndFetch();

        const handleFullscreenChange = () => {
            if (!document.fullscreenElement) {
                onClose();
            }
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);

        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
            if (document.fullscreenElement) {
                document.exitFullscreen();
            }
        };
    }, [sourceText, onClose]);

    const handleAnswerChange = (qIndex, oIndex) => {
        setUserAnswers(prev => ({ ...prev, [qIndex]: oIndex }));
    };

    const handleSubmitQuiz = () => {
        let calculatedScore = 0;
        quizData.forEach((question, index) => {
            if (userAnswers[index] === question.correctAnswerIndex) {
                calculatedScore++;
            }
        });
        setTotalScore(prev => {
            const previousAttemptScore = allResults[currentLevel]?.score || 0;
            return (prev - previousAttemptScore) + calculatedScore;
        });
        setAllResults(prev => ({
            ...prev,
            [currentLevel]: { score: calculatedScore, total: quizData.length, quizData, userAnswers }
        }));
        setLastLevelResult({ score: calculatedScore, total: quizData.length });
        const currentLevelIndex = QUIZ_LEVELS.indexOf(currentLevel);
        if (currentLevelIndex === QUIZ_LEVELS.length - 1) {
            setView('results');
        } else {
            setView('levelComplete');
        }
    };

    const handleStartNextLevel = async () => {
        const currentLevelIndex = QUIZ_LEVELS.indexOf(currentLevel);
        const nextLevel = QUIZ_LEVELS[currentLevelIndex + 1];
        if(nextLevel) {
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

    const handleCloseAndExitFullscreen = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen().then(onClose).catch(onClose);
        } else {
            onClose();
        }
    };

    const renderLoading = () => ( <div className="quiz-loading"><div className="loading-spinner"></div><p>Generating your {currentLevel} quiz...</p></div> );
    const renderError = () => ( <div className="quiz-error"><h3>Oops! Something went wrong.</h3><p>{error}</p><button className="quiz-submit-button" onClick={handleCloseAndExitFullscreen}>Close</button></div> );
    const renderQuiz = () => ( <> <div className="quiz-modal-header"><h3>Test Your Understanding (Level: {currentLevel})</h3></div> <div className="quiz-modal-body">{quizData.map((q, qIndex) => ( <div key={qIndex} className="quiz-question-block"><p className="quiz-question-text">{`${qIndex + 1}. ${q.question}`}</p><div className="quiz-options-list">{q.options.map((option, oIndex) => ( <label key={oIndex} className={`quiz-option-label ${userAnswers[qIndex] === oIndex ? 'selected' : ''}`}><input type="radio" name={`q-${qIndex}`} checked={userAnswers[qIndex] === oIndex} onChange={() => handleAnswerChange(qIndex, oIndex)} />{option}</label>))}</div></div>))}</div> <div className="quiz-modal-footer"><button className="quiz-submit-button" onClick={handleSubmitQuiz}>Submit Answers</button></div> </> );
    const renderLevelCompleteView = () => { if (!lastLevelResult) return null; const didPass = lastLevelResult.score >= PASSING_SCORE; const isFinalLevel = QUIZ_LEVELS.indexOf(currentLevel) === QUIZ_LEVELS.length - 1; return ( <div className="level-complete-view fade-in"><h2 style={{color: 'black'}}>Level Complete: {currentLevel}</h2><div className="quiz-score-badge" style={{backgroundColor: '#444', color: '#fff', padding: '1rem 2rem', fontSize: '1.2rem'}}>You scored <strong>{lastLevelResult.score}</strong> out of <strong>{lastLevelResult.total}</strong></div>{didPass ? ( isFinalLevel ? ( <> <p style={{color: 'green'}} className="level-complete-message success">Congratulations! You have passed all levels!</p> <button className="quiz-submit-button" onClick={handleShowFinalResults}>View Final Results</button> </> ) : ( <> <p style={{color: 'black'}} className="level-complete-message success">Congratulations! You've unlocked the next level.</p> <button className="quiz-submit-button" onClick={handleStartNextLevel}>Start '{QUIZ_LEVELS[QUIZ_LEVELS.indexOf(currentLevel) + 1]}' Level</button> </> ) ) : ( <div className="recommendation-section"><p style={{color: 'red'}} className="level-complete-message failure">You need a score of {PASSING_SCORE} or higher to proceed. Here's some feedback.</p>{isFetchingRecommendation && <div className="loading-spinner small"></div>}{recommendationData && ( <div className="recommendation-content fade-in"><p style={{color: 'black'}} className="recommendation-message">{recommendationData.message}</p>{recommendationData.conceptsToReview?.length > 0 && ( <div className="recommendation-block"><h4 style={{color: 'black'}}>Concepts to Review</h4><ul style={{color: 'black', listStyle: 'none'}}>{recommendationData.conceptsToReview.map((concept, i) => <li key={i}>{concept}</li>)}</ul></div>)}{recommendationData.suggestedCourses?.length > 0 && ( <div style={{color: 'black'}} className="recommendation-block"><h4 style={{color: 'black'}}>Suggested Learning</h4><ul style={{color: 'black', listStyle: 'none'}}>{recommendationData.suggestedCourses.map((course, i) => <li key={i}>{course}</li>)}</ul></div>)}</div>)}{<div className="level-complete-actions"><button className="quiz-submit-button try-again-button" onClick={handleRetryLevel}>Try This Level Again</button><button className="quiz-submit-button secondary" onClick={handleShowFinalResults}>End & View Results</button></div>}</div> )}</div> ); };
    const renderResults = () => ( <> <div className="quiz-modal-header"><h3 style={{color: 'black'}}>Final Quiz Challenge Results</h3></div><div className="quiz-modal-body"><div className="quiz-results-summary"><div className="quiz-score-badge">Your final total score is {totalScore} out of {Object.values(allResults).reduce((acc, level) => acc + level.total, 0)}</div></div>{QUIZ_LEVELS.map(level => { const result = allResults[level]; if (!result) return null; return ( <div key={level} className="level-result-block"><h4>{level} Level: {result.score} / {result.total}</h4>{result.quizData.map((q, index) => { const isCorrect = result.userAnswers[index] === q.correctAnswerIndex; return ( <div key={index} className={`quiz-result-item ${isCorrect ? 'correct' : 'incorrect'}`}><p><strong>{index + 1}. {q.question}</strong></p>{!isCorrect && <p style={{color: '#d32f2f'}}>Your answer: {q.options[result.userAnswers[index]] || "No answer"}</p>}<p className="quiz-result-explanation">💡 {q.explanation}</p></div> ); })}</div> ); })}</div><div className="quiz-modal-footer"><button className="quiz-submit-button" onClick={handleCloseAndExitFullscreen}>Finish</button></div></> );
    const renderContent = () => { if (isLoading) return renderLoading(); switch (view) { case 'quiz': return renderQuiz(); case 'levelComplete': return renderLevelCompleteView(); case 'results': return renderResults(); case 'error': return renderError(); default: return renderLoading(); } };
    return ( <div className="modal-overlay"><div ref={quizModalRef} className="modal-content quiz-modal"><button className="modal-close-button" onClick={handleCloseAndExitFullscreen}><CloseIcon /></button>{renderContent()}</div></div> );
};

const PlusIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>;
const HistoryIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.19-9.51L1 10"/></svg>;
const FileIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>;
const HamburgerIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>;
const MoreHorizontalIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>;
const SearchIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>;
const CloseIcon = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>;
const DownloadIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>;
const BackIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>;
const LoadingOverlay = ({ messages }) => { const [currentMessageIndex, setCurrentMessageIndex] = useState(0); useEffect(() => { const interval = setInterval(() => { setCurrentMessageIndex(prevIndex => (prevIndex + 1) % messages.length); }, 2500); return () => clearInterval(interval); }, [messages]); return (<div className="loading-overlay"><div className="loading-popup"><div className="loading-spinner"></div><p className="loading-message">{messages[currentMessageIndex]}</p></div></div>); };
const PodcastGenerator = ({ topic, onClose }) => { const [language, setLanguage] = useState('en'); const [isLoading, setIsLoading] = useState(false); const [error, setError] = useState(null); const [audioUrl, setAudioUrl] = useState(null); const audioPlayerRef = useRef(null); useEffect(() => { if (audioUrl && audioPlayerRef.current) { audioPlayerRef.current.play().catch(error => { console.error("Audio play was prevented:", error); setError("Playback was blocked by the browser. Please press play manually."); }); } }, [audioUrl]); const handleGenerate = async () => { if (!topic) return; setIsLoading(true); setError(null); setAudioUrl(null); try { const res = await fetch('http://localhost:5002/podcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, targetLanguage: language }) }); const contentType = res.headers.get('content-type'); if (!res.ok || !contentType || !contentType.startsWith('audio/')) { const errData = await res.json().catch(() => ({ error: "Server returned a non-JSON error response." })); throw new Error(errData.error || 'Server did not return valid audio.'); } const blob = await res.blob(); const url = URL.createObjectURL(blob); setAudioUrl(url); } catch (err) { console.error(err); setError(`Failed to generate audio: ${err.message}`); } finally { setIsLoading(false); } }; return ( <div className="modal-overlay" onClick={onClose}><div className="modal-content" onClick={e => e.stopPropagation()}><button className="modal-close-button" onClick={onClose}><CloseIcon /></button><div className="podcast-generator"><h3 className="podcast-title">🎙️ Listen to Explanation</h3><p className="podcast-topic">Topic: {topic.substring(0, 100)}...</p>{audioUrl ? ( <audio ref={audioPlayerRef} src={audioUrl} controls className="audio-player"> Your browser does not support the audio element. </audio> ) : ( <> <select className="language-select" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isLoading}> <option value="en">English</option> <option value="hi">Hindi</option> <option value="te">Telugu</option> <option value="ta">Tamil</option> <option value="es">Spanish</option> </select> <button className="generate-podcast-button" onClick={handleGenerate} disabled={isLoading || !topic}> {isLoading ? 'Generating...' : 'Generate Podcast'} </button> </> )}{error && <p className="error-message">{error}</p>}</div></div></div> ); };
const HistoryItem = ({ item, onDelete, onRename }) => { const [isMenuOpen, setIsMenuOpen] = useState(false); const [isRenaming, setIsRenaming] = useState(false); const [editedQuery, setEditedQuery] = useState(item.query); const menuRef = useRef(null); useEffect(() => { const handleClickOutside = (event) => { if (menuRef.current && !menuRef.current.contains(event.target)) setIsMenuOpen(false); }; document.addEventListener("mousedown", handleClickOutside); return () => document.removeEventListener("mousedown", handleClickOutside); }, [menuRef]); const handleRenameSubmit = (e) => { e.preventDefault(); onRename(item._id, editedQuery); setIsRenaming(false); setIsMenuOpen(false); }; return ( <div className="list-item-container"> {isRenaming ? ( <form onSubmit={handleRenameSubmit} className="rename-form"> <input type="text" value={editedQuery} onChange={(e) => setEditedQuery(e.target.value)} autoFocus onBlur={handleRenameSubmit} /> </form> ) : ( <span className="list-item-text">{item.query}</span> )} <div className="list-item-menu" ref={menuRef}> <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="menu-button"><MoreHorizontalIcon /></button> {isMenuOpen && ( <div className="dropdown-menu"> <button onClick={() => { setIsRenaming(true); setIsMenuOpen(false); }}>Rename</button> <button onClick={() => onDelete(item._id)} className="delete-button">Delete</button> </div> )} </div> </div> ); };
const Sidebar = ({ history, files, onNewChat, onFileImport, isOpen, onClose, onDeleteItem, onRenameItem, onAnalyzeFile }) => ( <aside className={`sidebar ${isOpen ? 'open' : ''}`}><button className="new-chat-button" onClick={onNewChat}><PlusIcon /> New Chat</button><div className="sidebar-section"><h3 className="section-title"><HistoryIcon /> History</h3><ul className="item-list">{history.map(item => <li key={item._id}><HistoryItem item={item} onDelete={onDeleteItem} onRename={onRenameItem} /></li>)}</ul></div><div className="sidebar-section"><h3 className="section-title"><FileIcon /> Files</h3><ul className="item-list">{files.map(file => ( <li key={file.name + file.lastModified} className="list-item file-item" onClick={() => onAnalyzeFile(file)} >{file.name}</li>))}</ul><button className="import-button" onClick={onFileImport}>Upload File</button></div></aside> );
const SynthesizedAnswer = ({ summary, keyPoints }) => ( <div className="synthesized-answer"><p className="summary-text">{summary}</p><h3 className="key-points-title">Key Takeaways</h3><ul className="key-points-list">{keyPoints && keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul></div> );
const WelcomeScreen = ({ onExampleClick }) => ( <div className="welcome-screen"><div className="welcome-header"><span className="welcome-gradient">Hello, Rajesh</span><h1>How can I help you today?</h1></div><div className="example-prompts"><div className="prompt-card" onClick={() => onExampleClick('Best JavaScript frameworks in 2024')}><h4>Compare frameworks</h4><p>Best JavaScript frameworks</p></div><div className="prompt-card" onClick={() => onExampleClick('What are the benefits of intermittent fasting?')}><h4>Get quick answers</h4><p>on health, science, and more</p></div><div className="prompt-card" onClick={() => onExampleClick('Latest news on AI development')}><h4>Find recent articles</h4><p>on AI development</p></div><div className="prompt-card" onClick={() => onExampleClick('Top restaurants near me')}><h4>Explore nearby places</h4><p>for top-rated restaurants</p></div></div></div> );
const SourcesList = ({ sources }) => { if (!sources || sources.length === 0) { return null; } return ( <div className="sources-container"><h3 className="sources-title">Sources</h3><ul className="sources-list">{sources.map((source, index) => ( <li key={index} className="source-item"><a href={source.link} target="_blank" rel="noopener noreferrer" className="source-link"><span className="source-index">{index + 1}.</span> {source.title}</a><p className="source-snippet">{source.snippet}</p></li>))}</ul></div> ); };
const FollowUpQuestions = ({ questions, onQuestionClick }) => { if (!questions || questions.length === 0) { return null; } return ( <div className="follow-up-container"><h3 className="follow-up-title">Continue Exploring</h3><div className="questions-wrapper">{questions.map((question, index) => ( <div key={index} className="follow-up-question" onClick={() => onQuestionClick(question)}>{question}</div>))}</div></div> ); };
const PrintPreviewPage = ({ onExit, analysisData, userQuery }) => { const [isGenerating, setIsGenerating] = useState(false); const [error, setError] = useState(null); const handleDownload = async () => { setIsGenerating(true); setError(null); try { const { summary, key_points } = analysisData; const response = await fetch('http://localhost:5001/generate-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary, key_points, query: userQuery }), }); if (!response.ok) { const errData = await response.json().catch(() => ({})); throw new Error(errData.error || 'PDF generation failed'); } const { pdfBase64, fileName } = await response.json(); const a = document.createElement('a'); a.href = `data:application/pdf;base64,${pdfBase64}`; a.download = fileName; document.body.appendChild(a); a.click(); document.body.removeChild(a); } catch (err) { console.error(err); setError(err.message); } finally { setIsGenerating(false); } }; useEffect(() => { const handleKeyDown = (event) => { if (event.key === 'Escape') { onExit(); } }; window.addEventListener('keydown', handleKeyDown); return () => { window.removeEventListener('keydown', handleKeyDown); }; }, [onExit]); return ( <div className="print-preview-container"> <button className="preview-exit-button non-printable" onClick={onExit}> <BackIcon/> Back to Analysis </button> <div className="print-preview-body"> <div className="pdf-page printable-area"> <h3 className="pdf-page-title">Analysis Report: {userQuery}</h3> <p className="pdf-page-summary">{analysisData.summary}</p> <h4 className="pdf-page-takeaways">Key Takeaways</h4> <ul className="pdf-page-list"> {analysisData.key_points.map((point, index) => <li key={index}>{point}</li>)} </ul> <div className="pdf-page-footer non-printable"> {error && <p className="error-message pdf-error">{error}</p>} <button className="button-primary" onClick={handleDownload} disabled={isGenerating}> {isGenerating ? 'Generating...' : <><DownloadIcon /> Download as PDF</>} </button> </div> </div> </div> </div> ); };
const ResponseActions = ({ onEnterPreviewMode, onGenerateQuiz, onPlayPodcast }) => { const [isMenuOpen, setIsMenuOpen] = useState(false); const menuRef = useRef(null); useEffect(() => { const handleClickOutside = (event) => { if (menuRef.current && !menuRef.current.contains(event.target)) setIsMenuOpen(false); }; document.addEventListener("mousedown", handleClickOutside); return () => document.removeEventListener("mousedown", handleClickOutside); }, []); return ( <div className="response-actions-menu" ref={menuRef}><button className="menu-toggle-button" onClick={() => setIsMenuOpen(!isMenuOpen)}><MoreHorizontalIcon /></button>{isMenuOpen && (<div className="actions-dropdown"><button onClick={() => { onGenerateQuiz(); setIsMenuOpen(false); }}>Generate Quiz</button><button onClick={() => { onPlayPodcast(); setIsMenuOpen(false); }}>Play Podcast</button><button onClick={() => { onEnterPreviewMode(); setIsMenuOpen(false); }}>Download / Print</button></div>)}</div> ); };


export default Chatbot;