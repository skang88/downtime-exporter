pipeline {
    agent any // Jenkins 에이전트에 Docker가 설치되어 있어야 합니다.

    environment {
        IMAGE_NAME = 'downtime-exporter'
        IMAGE_TAG = "v1.0.${env.BUILD_NUMBER}"
    }

    stages {
        stage('Build Docker Image') {
            steps {
                script {
                    echo "Building Docker image: ${IMAGE_NAME}:${IMAGE_TAG}"
                    docker.build("${IMAGE_NAME}:${IMAGE_TAG}", '.')
                }
            }
        }

        stage('Deploy (Local)') {
            steps {
                script {
                    def dockerImage = "${IMAGE_NAME}:${env.BUILD_NUMBER}"
                    echo "Deploying image ${dockerImage} on the Jenkins agent..."

                    // Jenkins 에이전트에서 기존 컨테이너를 중지하고 새 버전으로 실행합니다.
                    // 이 단계는 Jenkins 에이전트가 Docker를 실행할 수 있어야 합니다.
                                sh '''
                                    docker stop ${IMAGE_NAME} || true
                                    docker rm ${IMAGE_NAME} || true
                                    docker run -d --restart always --name ${IMAGE_NAME} -p 8001:9101 ${dockerImage}
                                '''                }
            }
        }
    }

    post {
        always {
            echo 'Pipeline finished.'
        }
    }
}