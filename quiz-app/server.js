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
let questions = [];
try {
  questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
} catch (e) {
  console.log('No questions.json found, using defaults');
  questions = [
    { id: 1, question: "What is the capital of the Netherlands?", answer: "Amsterdam" },
    { id: 2, question: "In what year did World War II end?", answer: "1945" },
    { id: 3, question: "What is the largest planet in our solar system?", answer: "Jupiter" }
  ];
}

// Game state
let gameState = {
  currentQuestionIndex: -1, // -1 means waiting to start
  showAnswer: false,
  players: {}, // { playerName: { answers: {questionId: answer}, score: 0 } }
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
app.get('/api/questions', (req, res) => {
  res.json(questions);
});

app.get('/api/state', (req, res) => {
  res.json(gameState);
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state to new connection
  socket.emit('gameState', getPublicGameState());
  socket.emit('playerList', Object.keys(gameState.players));

  // Player joins
  socket.on('playerJoin', (playerName) => {
    if (!gameState.players[playerName]) {
      gameState.players[playerName] = { answers: {}, score: 0 };
    }
    socket.playerName = playerName;
    console.log(`Player joined: ${playerName}`);
    io.emit('playerList', Object.keys(gameState.players));
    io.emit('playerUpdate', getPlayersWithScores());
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

  // Admin controls
  socket.on('startQuiz', () => {
    gameState.quizStarted = true;
    gameState.currentQuestionIndex = 0;
    gameState.showAnswer = false;
    io.emit('gameState', getPublicGameState());
    console.log('Quiz started!');
  });

  socket.on('nextQuestion', () => {
    if (gameState.currentQuestionIndex < questions.length - 1) {
      gameState.currentQuestionIndex++;
      gameState.showAnswer = false;
      io.emit('gameState', getPublicGameState());
      console.log(`Moving to question ${gameState.currentQuestionIndex + 1}`);
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

  socket.on('resetQuiz', () => {
    gameState = {
      currentQuestionIndex: -1,
      showAnswer: false,
      players: {},
      quizStarted: false
    };
    io.emit('gameState', getPublicGameState());
    io.emit('playerList', []);
    io.emit('playerUpdate', []);
    console.log('Quiz reset!');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

function getPublicGameState() {
  const currentQuestion = gameState.currentQuestionIndex >= 0
    ? questions[gameState.currentQuestionIndex]
    : null;

  return {
    currentQuestionIndex: gameState.currentQuestionIndex,
    currentQuestion: currentQuestion ? {
      id: currentQuestion.id,
      question: currentQuestion.question,
      answer: gameState.showAnswer ? currentQuestion.answer : null
    } : null,
    showAnswer: gameState.showAnswer,
    totalQuestions: questions.length,
    quizStarted: gameState.quizStarted
  };
}

function getPlayersWithScores() {
  return Object.entries(gameState.players).map(([name, data]) => ({
    name,
    score: data.score,
    answeredCount: Object.keys(data.answers).length,
    currentAnswer: gameState.currentQuestionIndex >= 0
      ? data.answers[questions[gameState.currentQuestionIndex]?.id]
      : null
  })).sort((a, b) => b.score - a.score);
}

server.listen(PORT, () => {
  console.log(`Pub Quiz server running on http://localhost:${PORT}`);
  console.log(`  Quiz display: http://localhost:${PORT}/quiz`);
  console.log(`  Admin panel:  http://localhost:${PORT}/quiz/admin`);
  console.log(`  Player join:  http://localhost:${PORT}/quiz/{name}`);
});
