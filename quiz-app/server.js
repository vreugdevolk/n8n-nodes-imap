const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Load questions
let quizData = { categories: [] };
try {
  quizData = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
} catch (e) {
  console.log('No questions.json found, using defaults');
  quizData = {
    categories: [
      {
        id: 1,
        name: "Algemeen",
        questions: [
          { id: 1, question: "Wat is de hoofdstad van Nederland?", answer: "Amsterdam" },
          { id: 2, question: "Hoeveel is 2 + 2?", answer: "4" }
        ]
      }
    ]
  };
}

// Game state
let gameState = {
  currentCategoryIndex: 0,
  currentQuestionIndex: -1, // -1 means waiting to start category
  showAnswer: false,
  players: {}, // { playerName: { answers: {}, score: 0, skipVotes: Set, bets: Set } }
  skipVotes: new Set(), // Players who voted to skip current category
  quizStarted: false
};

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Routes
app.get('/quiz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quiz.html'));
});

app.get('/quiz/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/quiz/:playerName', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// API endpoints
app.get('/api/categories', (req, res) => {
  res.json(quizData.categories.map(c => ({ id: c.id, name: c.name, questionCount: c.questions.length })));
});

app.get('/api/state', (req, res) => {
  res.json(getPublicGameState());
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state to new connection
  socket.emit('gameState', getPublicGameState());
  socket.emit('playerUpdate', getPlayersWithScores());

  // Player joins
  socket.on('playerJoin', (playerName) => {
    if (!gameState.players[playerName]) {
      gameState.players[playerName] = {
        answers: {},
        score: 0,
        bets: new Set() // Question IDs the player is betting on
      };
    }
    socket.playerName = playerName;
    console.log(`Player joined: ${playerName}`);
    io.emit('playerUpdate', getPlayersWithScores());
    // Update skip votes display when player count changes
    io.emit('skipVoteUpdate', getSkipVoteStatus());
  });

  // Player submits answer
  socket.on('submitAnswer', ({ playerName, questionId, answer }) => {
    if (gameState.players[playerName]) {
      gameState.players[playerName].answers[questionId] = answer;
      console.log(`${playerName} answered Q${questionId}: ${answer}`);
      io.emit('answerSubmitted', { playerName, questionId });
      io.emit('playerUpdate', getPlayersWithScores());
    }
  });

  // Player places a bet on current question
  socket.on('placeBet', ({ playerName }) => {
    if (gameState.players[playerName] && gameState.currentQuestionIndex >= 0) {
      const category = quizData.categories[gameState.currentCategoryIndex];
      const question = category?.questions[gameState.currentQuestionIndex];
      if (question && !gameState.showAnswer) {
        gameState.players[playerName].bets.add(question.id);
        console.log(`${playerName} placed a bet on Q${question.id}`);
        io.emit('playerUpdate', getPlayersWithScores());
        socket.emit('betPlaced', { questionId: question.id });
      }
    }
  });

  // Player votes to skip category
  socket.on('voteSkipCategory', ({ playerName }) => {
    if (gameState.players[playerName] && gameState.quizStarted) {
      gameState.skipVotes.add(playerName);
      console.log(`${playerName} voted to skip category`);

      const skipStatus = getSkipVoteStatus();
      io.emit('skipVoteUpdate', skipStatus);

      // Check if majority wants to skip
      if (skipStatus.shouldSkip) {
        skipToNextCategory();
      }
    }
  });

  // Player removes skip vote
  socket.on('removeSkipVote', ({ playerName }) => {
    if (gameState.players[playerName]) {
      gameState.skipVotes.delete(playerName);
      io.emit('skipVoteUpdate', getSkipVoteStatus());
    }
  });

  // Admin controls
  socket.on('startQuiz', () => {
    gameState.quizStarted = true;
    gameState.currentCategoryIndex = 0;
    gameState.currentQuestionIndex = 0;
    gameState.showAnswer = false;
    gameState.skipVotes = new Set();
    io.emit('gameState', getPublicGameState());
    io.emit('skipVoteUpdate', getSkipVoteStatus());
    console.log('Quiz started!');
  });

  socket.on('nextQuestion', () => {
    const category = quizData.categories[gameState.currentCategoryIndex];
    if (!category) return;

    if (gameState.currentQuestionIndex < category.questions.length - 1) {
      gameState.currentQuestionIndex++;
      gameState.showAnswer = false;
      io.emit('gameState', getPublicGameState());
      console.log(`Moving to question ${gameState.currentQuestionIndex + 1}`);
    } else {
      // Move to next category
      skipToNextCategory();
    }
  });

  socket.on('prevQuestion', () => {
    if (gameState.currentQuestionIndex > 0) {
      gameState.currentQuestionIndex--;
      gameState.showAnswer = false;
      io.emit('gameState', getPublicGameState());
      console.log(`Moving to question ${gameState.currentQuestionIndex + 1}`);
    }
  });

  socket.on('nextCategory', () => {
    skipToNextCategory();
  });

  socket.on('toggleAnswer', () => {
    gameState.showAnswer = !gameState.showAnswer;
    io.emit('gameState', getPublicGameState());
    console.log(`Answer visibility: ${gameState.showAnswer}`);
  });

  socket.on('updateScore', ({ playerName, score }) => {
    if (gameState.players[playerName]) {
      gameState.players[playerName].score = score;
      io.emit('playerUpdate', getPlayersWithScores());
    }
  });

  // Award points (handles betting automatically)
  socket.on('awardPoints', ({ playerName, points, questionId }) => {
    if (gameState.players[playerName]) {
      const player = gameState.players[playerName];
      const hasBet = player.bets.has(questionId);

      let actualPoints = points;
      if (hasBet) {
        actualPoints = points * 2; // Double points if bet
      }

      player.score += actualPoints;
      console.log(`Awarded ${actualPoints} points to ${playerName} (bet: ${hasBet})`);
      io.emit('playerUpdate', getPlayersWithScores());
    }
  });

  // Deduct points for wrong bet
  socket.on('deductBetPoints', ({ playerName, points, questionId }) => {
    if (gameState.players[playerName]) {
      const player = gameState.players[playerName];
      const hasBet = player.bets.has(questionId);

      if (hasBet) {
        player.score -= points; // Lose points if bet and wrong
        console.log(`Deducted ${points} points from ${playerName} for wrong bet`);
        io.emit('playerUpdate', getPlayersWithScores());
      }
    }
  });

  socket.on('resetQuiz', () => {
    gameState = {
      currentCategoryIndex: 0,
      currentQuestionIndex: -1,
      showAnswer: false,
      players: {},
      skipVotes: new Set(),
      quizStarted: false
    };
    io.emit('gameState', getPublicGameState());
    io.emit('playerUpdate', []);
    io.emit('skipVoteUpdate', getSkipVoteStatus());
    console.log('Quiz reset!');
  });

  socket.on('disconnect', () => {
    if (socket.playerName) {
      gameState.skipVotes.delete(socket.playerName);
      io.emit('skipVoteUpdate', getSkipVoteStatus());
    }
    console.log('Client disconnected:', socket.id);
  });
});

function skipToNextCategory() {
  if (gameState.currentCategoryIndex < quizData.categories.length - 1) {
    gameState.currentCategoryIndex++;
    gameState.currentQuestionIndex = 0;
    gameState.showAnswer = false;
    gameState.skipVotes = new Set(); // Reset skip votes for new category
    io.emit('gameState', getPublicGameState());
    io.emit('skipVoteUpdate', getSkipVoteStatus());
    console.log(`Skipped to category ${gameState.currentCategoryIndex + 1}: ${quizData.categories[gameState.currentCategoryIndex].name}`);
  } else {
    // Quiz finished
    gameState.currentQuestionIndex = -1;
    io.emit('gameState', getPublicGameState());
    console.log('Quiz finished!');
  }
}

function getSkipVoteStatus() {
  const totalPlayers = Object.keys(gameState.players).length;
  const skipVoteCount = gameState.skipVotes.size;
  const votesNeeded = Math.floor(totalPlayers / 2) + 1; // More than half

  return {
    skipVoteCount,
    totalPlayers,
    votesNeeded,
    shouldSkip: totalPlayers > 0 && skipVoteCount >= votesNeeded,
    voters: Array.from(gameState.skipVotes)
  };
}

function getPublicGameState() {
  const category = quizData.categories[gameState.currentCategoryIndex];
  const question = category && gameState.currentQuestionIndex >= 0
    ? category.questions[gameState.currentQuestionIndex]
    : null;

  return {
    currentCategoryIndex: gameState.currentCategoryIndex,
    currentCategory: category ? { id: category.id, name: category.name, questionCount: category.questions.length } : null,
    currentQuestionIndex: gameState.currentQuestionIndex,
    currentQuestion: question ? {
      id: question.id,
      question: question.question,
      answer: gameState.showAnswer ? question.answer : null
    } : null,
    showAnswer: gameState.showAnswer,
    totalCategories: quizData.categories.length,
    quizStarted: gameState.quizStarted,
    isFinished: gameState.quizStarted && gameState.currentCategoryIndex >= quizData.categories.length - 1 && gameState.currentQuestionIndex < 0
  };
}

function getPlayersWithScores() {
  const category = quizData.categories[gameState.currentCategoryIndex];
  const currentQuestion = category && gameState.currentQuestionIndex >= 0
    ? category.questions[gameState.currentQuestionIndex]
    : null;

  return Object.entries(gameState.players).map(([name, data]) => ({
    name,
    score: data.score,
    answeredCount: Object.keys(data.answers).length,
    currentAnswer: currentQuestion ? data.answers[currentQuestion.id] : null,
    hasBetOnCurrent: currentQuestion ? data.bets.has(currentQuestion.id) : false,
    hasVotedSkip: gameState.skipVotes.has(name)
  })).sort((a, b) => b.score - a.score);
}

server.listen(PORT, () => {
  console.log(`Pub Quiz server running on http://localhost:${PORT}`);
  console.log(`  Quiz display: http://localhost:${PORT}/quiz`);
  console.log(`  Admin panel:  http://localhost:${PORT}/quiz/admin`);
  console.log(`  Player join:  http://localhost:${PORT}/quiz/{name}`);
  console.log(`\n  Categories: ${quizData.categories.length}`);
  quizData.categories.forEach((c, i) => {
    console.log(`    ${i + 1}. ${c.name} (${c.questions.length} questions)`);
  });
});
